import { TrackerUnavailableError } from "../../domain/contracts.ts";
import type { TicketRef } from "../../domain/model.ts";
import { parseRef } from "../../domain/refs/parse.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import { savedSite } from "../../sign-in/credentials.ts";
import type { LaneTrackerPort } from "../../execution/lane/service.ts";
import type { StateStore } from "../../persistence/state.ts";
import { trackerAccount, trackerOf } from "./registry.ts";
import { journalTrackerWrite, verifyJournaledWrite } from "./write-journal.ts";

export function signedInLaneTracker(services: RuntimeServices, store: StateStore): LaneTrackerPort {
  const connect = async (ticket: TicketRef) => {
    const ref = parseRef(ticket);
    const entry = trackerOf(ticket);
    if (!entry || !ref.instance || !ref.namespace)
      throw new TrackerUnavailableError(`No signed-in tracker serves ${ticket}`);
    const site =
      entry.siteOf?.(ref.instance) ?? savedSite(services, trackerAccount(entry, services));
    if (!site || entry.instance(site) !== ref.instance)
      throw new TrackerUnavailableError(
        `Not signed in to ${entry.label} for ${ref.instance}; run interlock login ${entry.name}`,
      );
    return entry.connect(services, site, ref.namespace).catch(() => {
      throw new TrackerUnavailableError(
        `Not signed in to ${entry.label} at ${site}; run interlock login ${entry.name}`,
      );
    });
  };
  const tracker = async (ticket: TicketRef) => (await connect(ticket)).tracker();
  return {
    removeMirror: async (claim) => {
      const mirror = (await connect(claim.ticket)).tracker({
        ...(claim.claimHome ? { claimHome: claim.claimHome } : {}),
        journalWrite: (pending) => journalTrackerWrite(store, claim.run, pending),
      });
      await verifyJournaledWrite(store, claim.run, claim.ticket, mirror);
      await mirror.removeMirror({
        ticket: claim.ticket,
        claim: claim.ref,
        run: claim.run,
        owner: claim.humanOwner,
      });
    },
    available: async (ticket) => {
      await connect(ticket);
    },
    read: async (ticket) => (await tracker(ticket)).read(ticket),
    complete: async (ticket) => {
      const current = await tracker(ticket);
      if (!current.complete) throw new Error("Tracker cannot mark the ticket done");
      await current.complete(ticket);
    },
    linkArtifact: async (ticket, url, title) => {
      const current = await tracker(ticket);
      if (!current.linkArtifact) throw new Error("Tracker cannot link artifacts");
      await current.linkArtifact(ticket, url, title);
    },
  };
}
