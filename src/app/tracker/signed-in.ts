import {
  JiraTrackerAdapter,
  jiraBasicAuthTransport,
} from "../../adapters/trackers/jira/tracker.ts";
import { TrackerUnavailableError } from "../../domain/contracts.ts";
import type { TicketRef } from "../../domain/model.ts";
import { parseRef } from "../../domain/refs/parse.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import { lookupCredentials, savedSite, trackerSignIns } from "../../sign-in/credentials.ts";
import type { LaneTrackerPort } from "../../execution/lane/service.ts";
import { jiraRankField } from "../pickup/runtime.ts";
import type { StateStore } from "../../persistence/state.ts";
import { journalJiraWrite, verifyJournaledJiraWrite } from "./write-journal.ts";

export function signedInLaneTracker(services: RuntimeServices, store: StateStore): LaneTrackerPort {
  const adapter = async (ticket: TicketRef) => {
    const ref = parseRef(ticket);
    if (ref.adapter !== "jira" || !ref.instance || !ref.namespace)
      throw new TrackerUnavailableError(`No signed-in tracker serves ${ticket}`);
    const site = savedSite(services, "jira");
    if (!site || new URL(site).hostname.replace(/\.atlassian\.net$/, "") !== ref.instance)
      throw new TrackerUnavailableError(
        `Not signed in to Jira for ${ref.instance}; run interlock login jira`,
      );
    const transport =
      services.execution?.jira ??
      (await signedInTransport(services, site).catch(() => {
        throw new TrackerUnavailableError(
          `Not signed in to Jira at ${site}; run interlock login jira`,
        );
      }));
    return { instance: ref.instance, namespace: ref.namespace, transport };
  };
  const jira = async (ticket: TicketRef) => new JiraTrackerAdapter(await adapter(ticket));
  const reader = async (ticket: TicketRef) => {
    const options = await adapter(ticket);
    return new JiraTrackerAdapter({
      ...options,
      rankField: await jiraRankField(options.transport),
    });
  };
  return {
    removeMirror: async (claim) => {
      const tracker = new JiraTrackerAdapter({
        ...(await adapter(claim.ticket)),
        ...(claim.claimHome ? { claimHome: claim.claimHome } : {}),
        journalWrite: (pending) => journalJiraWrite(store, claim.run, pending),
      });
      await verifyJournaledJiraWrite(store, claim.run, claim.ticket, tracker);
      await tracker.removeMirror({
        ticket: claim.ticket,
        claim: claim.ref,
        run: claim.run,
        owner: claim.humanOwner,
      });
    },
    available: async (ticket) => {
      await adapter(ticket);
    },
    read: async (ticket) => (await reader(ticket)).read(ticket),
    transition: async (ticket, status) => (await jira(ticket)).transition(ticket, status),
    link_artifact: async (ticket, url, title) =>
      (await jira(ticket)).link_artifact(ticket, url, title),
  };
}

async function signedInTransport(services: RuntimeServices, site: string) {
  const { credentials } = await lookupCredentials(
    services,
    "jira",
    trackerSignIns(services).jira.adapter,
    site,
  );
  if (!credentials) throw new Error("missing credentials");
  return jiraBasicAuthTransport({ site, ...credentials }, services.signIn?.http);
}
