import { Nat } from '@agoric/nat';
import { assert, details as X } from '@agoric/assert';
import { insistLocalType } from './parseLocalSlots';
import { flipRemoteSlot, makeRemoteSlot } from './parseRemoteSlot';
import { getRemote } from './remote';
import { cdebug } from './cdebug';

export function makeIngressEgress(state, provideLocalForRemote) {
  function addEgress(remoteID, remoteRefID, loid) {
    // Make 'loid' available to remoteID as 'remoteRefID'. This is kind of
    // like provideRemoteForLocal, but it uses a caller-provided remoteRef instead of
    // allocating a new one. This is used to bootstrap initial connectivity
    // between machines.
    const remote = getRemote(state, remoteID);
    Nat(remoteRefID);
    insistLocalType('object', loid);
    assert(!remote.toRemote.has(loid), X`already present ${loid}`);

    const inboundRRef = makeRemoteSlot('object', true, remoteRefID);
    const outboundRRef = flipRemoteSlot(inboundRRef);
    assert(!remote.fromRemote.has(inboundRRef), X`already have ${inboundRRef}`);
    assert(!remote.toRemote.has(outboundRRef), X`already have ${outboundRRef}`);
    remote.fromRemote.set(inboundRRef, loid);
    remote.toRemote.set(loid, outboundRRef);
    if (remote.nextObjectIndex <= remoteRefID) {
      remote.nextObjectIndex = remoteRefID + 1n;
    }
    // prettier-ignore
    cdebug(`comms add egress ${loid} to ${remoteID} in ${inboundRRef} out ${outboundRRef}`);
  }

  // to let machine2 access 'o-5' on machine1, pick an unused index (12), then:
  // * machine1 does addEgress('machine2', 12, 'o-5')
  // * machine2 does addIngress('machine1', 12, 'o+8')
  // Messages sent to the object:
  // * machine2 toRemote[o+8] = ro+12
  // * machine1 fromRemote[ro+12] = o-5
  // Messages sent from m1 to m2 that reference the object:
  // * machine1 toRemote[o-5] = ro-12
  // * machine2 fromRemote[ro-12] = o+8

  function addIngress(remoteID, remoteRefID) {
    // Return a local object-id that maps to a remote object with index
    // 'remoteRefID'. Just a wrapper around provideLocalForRemote.
    const inboundRRef = makeRemoteSlot('object', false, remoteRefID);
    const loid = provideLocalForRemote(remoteID, inboundRRef);
    cdebug(`comms add ingress ${loid} to ${remoteID} in ${inboundRRef}`);
    return loid;
  }

  return harden({ addEgress, addIngress });
}
