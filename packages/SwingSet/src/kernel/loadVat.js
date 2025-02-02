import { assert, details as X } from '@agoric/assert';
import { assertKnownOptions } from '../assertOptions';
import { makeVatSlot } from '../parseVatSlots';
import { insistCapData } from '../capdata';

export function makeVatRootObjectSlot() {
  return makeVatSlot('object', true, 0n);
}

export function makeVatLoader(stuff) {
  const {
    allocateUnusedVatID,
    vatNameToID,
    vatManagerFactory,
    kernelSlog,
    makeVatConsole,
    addVatManager,
    addExport,
    queueToExport,
    kernelKeeper,
    panic,
  } = stuff;

  /**
   * Create a new vat at runtime (called from the vatAdmin device).
   *
   * @param {*} source  The source object implementing the vat
   * @param {*} dynamicOptions  Options bag governing vat creation
   *
   * @returns {string}  The vatID of the newly created vat
   */
  function createVatDynamically(source, dynamicOptions = {}) {
    const vatID = allocateUnusedVatID();
    kernelKeeper.addDynamicVatID(vatID);
    const vatKeeper = kernelKeeper.allocateVatKeeper(vatID);
    vatKeeper.setSourceAndOptions(source, dynamicOptions);
    // eslint-disable-next-line no-use-before-define
    create(vatID, source, dynamicOptions, true, true);
    // we ignore the Promise create() returns: the invoking vat will be
    // notified via makeSuccessResponse rather than via the return value of
    // this function
    return vatID;
  }

  /**
   * Recreate a dynamic vat from persistent state at kernel startup time.
   *
   * @param {string} vatID  The vatID of the vat to create
   * @param {*} source  The source object implementing the vat
   * @param {*} dynamicOptions  Options bag governing vat creation
   *
   * @returns {string}  The vatID of the vat
   */
  function recreateDynamicVat(vatID, source, dynamicOptions) {
    // eslint-disable-next-line no-use-before-define
    create(vatID, source, dynamicOptions, false, true);
    // again we ignore create()'s Promise
    return vatID;
  }

  /**
   * Recreate a static vat from persistent state at kernel startup time.
   *
   * @param {string} vatID  The vatID of the vat to create
   * @param {*} source  The source object implementing the vat
   * @param {*} staticOptions  Options bag governing vat creation
   *
   * @returns {Promise<void>} A Promise which fires (with undefined) when the
   * vat is ready for messages.
   */
  function recreateStaticVat(vatID, source, staticOptions) {
    // eslint-disable-next-line no-use-before-define
    return create(vatID, source, staticOptions, false, false);
  }

  const allowedDynamicOptions = [
    'description',
    'metered',
    'managerType', // TODO: not sure we want vats to be able to control this
    'vatParameters',
    'enableSetup',
    'enablePipelining',
    'virtualObjectCacheSize',
  ];

  const allowedStaticOptions = [
    'description',
    'name',
    'vatParameters',
    'managerType',
    'enableDisavow',
    'enableSetup',
    'enablePipelining',
    'virtualObjectCacheSize',
  ];

  /**
   * Instantiate a new vat.  The root object will be available soon, but we
   * immediately return the vatID so the ultimate requestor doesn't have to
   * wait.
   *
   * @param {string} vatID  The vatID for the new vat
   * @param {*} source  an object which either has a `bundle` (JSON-serializable
   *    data) or a `bundleName` string. The bundle defines the vat, and should
   *    be generated by calling bundle-source on a module with an export named
   *    `makeRootObject()` (or possibly `setup()` if the 'enableSetup' option is
   *    true). If `bundleName` is used, it must identify a bundle already known
   *    to the kernel (via the `config.bundles` table) which satisfies these
   *    constraints.
   * @param {*} options  an options bag. These options are currently understood:
   *
   *    'metered' if true, subjects the new dynamic vat to a meter that limits
   *        the amount of computation and allocation that can occur during any
   *        given crank. Stack frames are limited as well. The meter is refilled
   *        between cranks, but if the meter ever underflows, the vat is
   *        terminated. If false, the vat is unmetered.  Defaults to true for
   *        dynamic vats; static vats may not be metered.
   *
   *    'vatParameters' provides the contents of the second argument to
   *        'buildRootObject()'.  Defaults to `{}`.
   *
   *    'enableSetup' If true, permits the vat to construct itself using the
   *        `setup()` API, which bypasses the imposition of LiveSlots but
   *        requires the vat implementation to enforce the vat invariants
   *        manually.  If false, the vat will be constructed using the
   *        `buildRootObject()` API, which uses LiveSlots to enforce the vat
   *        invariants automatically.  Defaults to false.
   *
   *    'enablePipelining' If true, permits the kernel to pipeline messages to
   *        promises for which the vat is the decider directly to the vat
   *        without waiting for the promises to be resolved.  If false, such
   *        messages will be queued inside the kernel.  Defaults to false.
   *
   * @param {boolean} notifyNewVat  If true, the success or failure of the
   *    operation will be reported in a message to the admin vat, citing the
   *    vatID
   * @param {boolean} isDynamic  If true, the vat being created is a dynamic vat;
   *    if false, it's a static vat (these have differences in their allowed
   *    options and some of their option defaults).
   *
   * @returns {Promise<void>} A Promise which fires (with undefined) when the
   * vat is ready for messages.
   */
  function create(vatID, source, options, notifyNewVat, isDynamic) {
    assert(source.bundle || source.bundleName, 'broken source');
    const vatSourceBundle =
      source.bundle || kernelKeeper.getBundle(source.bundleName);
    assert(vatSourceBundle, X`Bundle ${source.bundleName} not found`);

    assertKnownOptions(
      options,
      isDynamic ? allowedDynamicOptions : allowedStaticOptions,
    );
    const {
      metered = isDynamic,
      vatParameters = {},
      managerType,
      enableSetup = false,
      enableDisavow = false,
      enablePipelining = false,
      virtualObjectCacheSize,
      name,
    } = options;
    let terminated = false;

    // TODO: maybe hash the bundle object somehow for the description
    const sourceDesc = source.bundle
      ? 'from source bundle'
      : `from bundleName: ${source.bundleName}`;
    const description = `${options.description || ''} (${sourceDesc})`.trim();

    function notifyTermination(shouldReject, info) {
      insistCapData(info);
      if (terminated) {
        return;
      }
      terminated = true;
      const vatAdminVatId = vatNameToID('vatAdmin');
      const vatAdminRootObjectSlot = makeVatRootObjectSlot();

      // Embedding the info capdata into the arguments list, taking advantage of
      // the fact that neither vatID (which is a string) nor shouldReject (which
      // is a boolean) can contain any slots.
      const args = {
        body: JSON.stringify([vatID, shouldReject, JSON.parse(info.body)]),
        slots: info.slots,
      };

      queueToExport(
        vatAdminVatId,
        vatAdminRootObjectSlot,
        'vatTerminated',
        args,
        'logFailure',
      );
    }

    async function build() {
      assert.typeof(
        vatSourceBundle,
        'object',
        X`vat creation requires a bundle, not a plain string`,
      );

      kernelSlog.addVat(vatID, isDynamic, description, name, vatSourceBundle);
      const managerOptions = {
        managerType,
        bundle: vatSourceBundle,
        metered,
        enableDisavow,
        enableSetup,
        enablePipelining,
        enableInternalMetering: !isDynamic,
        notifyTermination,
        vatConsole: makeVatConsole('vat', vatID),
        liveSlotsConsole: makeVatConsole('ls', vatID),
        vatParameters,
        virtualObjectCacheSize,
      };
      // TODO: We need to support within-vat metering (for the Spawner) until
      // #1343 is fixed, after which we can remove
      // managerOptions.enableInternalMetering.  For now, it needs to be enabled
      // for our internal unit test (which could easily add this to its config
      // object) and for the spawner vat (not so easy). To avoid deeper changes,
      // we enable it for *all* static vats here. Once #1343 is fixed, remove
      // this addition and all support for internal metering.

      const finish = kernelSlog.startup(vatID);
      const manager = await vatManagerFactory(vatID, managerOptions);
      finish();
      addVatManager(vatID, manager, managerOptions);
    }

    function makeSuccessResponse() {
      // build success message, giving admin vat access to the new vat's root
      // object
      const kernelRootObjSlot = addExport(vatID, makeVatRootObjectSlot());

      return {
        body: JSON.stringify([
          vatID,
          { rootObject: { '@qclass': 'slot', index: 0 } },
        ]),
        slots: [kernelRootObjSlot],
      };
    }

    function makeErrorResponse(error) {
      return {
        body: JSON.stringify([vatID, { error: `${error}` }]),
        slots: [],
      };
    }

    function errorDuringReplay(error) {
      // if we fail to recreate the vat during replay, crash the kernel,
      // because we no longer have any way to inform the original caller
      panic(`unable to re-create vat ${vatID}`, error);
    }

    function sendResponse(args) {
      const vatAdminVatId = vatNameToID('vatAdmin');
      const vatAdminRootObjectSlot = makeVatRootObjectSlot();
      queueToExport(
        vatAdminVatId,
        vatAdminRootObjectSlot,
        'newVatCallback',
        args,
        'logFailure',
      );
    }

    // vatManagerFactory is async, so we prepare a callback chain to execute
    // the resulting setup function, create the new vat around the resulting
    // dispatch object, and notify the admin vat of our success (or failure).
    // We presume that importBundle's Promise will fire promptly (before
    // setImmediate does, i.e. importBundle is async but doesn't do any IO,
    // so it doesn't really need to be async), because otherwise the
    // queueToExport might fire (and insert messages into the kernel run
    // queue) in the middle of some other vat's crank. TODO: find a safer
    // way, maybe the response should go out to the controller's "queue
    // things single file into the kernel" queue, once such a thing exists.
    const p = Promise.resolve().then(build);
    if (notifyNewVat) {
      p.then(makeSuccessResponse, makeErrorResponse)
        .then(sendResponse)
        .catch(err => console.error(`error in vat creation`, err));
    } else {
      p.catch(errorDuringReplay);
    }

    return p;
  }

  async function loadTestVat(vatID, setup, creationOptions) {
    const managerOptions = {
      ...creationOptions,
      setup,
      enableSetup: true,
      managerType: 'local',
    };
    const manager = await vatManagerFactory(vatID, managerOptions);
    addVatManager(vatID, manager, managerOptions);
  }

  return harden({
    createVatDynamically,
    recreateDynamicVat,
    recreateStaticVat,
    loadTestVat,
  });
}
