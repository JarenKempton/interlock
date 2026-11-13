import { z } from "zod";
import { githubIssues } from "../../adapters/trackers/github/registration.ts";
import type { GitHubTransport } from "../../adapters/trackers/github/transport.ts";
import { jiraSignIn } from "../../adapters/trackers/jira/sign-in.ts";
import {
  JiraTrackerAdapter,
  type JiraTransport,
  jiraBasicAuthTransport,
} from "../../adapters/trackers/jira/tracker.ts";
import type { ActorRef, MapRef, TicketRef } from "../../domain/model.ts";
import { actorRefSchema, mapRefSchema, ticketRefSchema } from "../../domain/refs/identifiers.ts";
import { parseRef } from "../../domain/refs/parse.ts";
import type { Tracker, TrackerSignIn } from "../../domain/tracker/port.ts";
import type { Ticket } from "../../domain/tracker/ticket.ts";
import { requireCredentials, type TrackerAccount } from "../../sign-in/credentials.ts";
import type { RuntimeServices } from "../runtime-services.ts";

export interface TrackerTransports {
  jira?: JiraTransport;
  github?: GitHubTransport;
}

export interface TrackerOptions {
  claimHome?: string;
  claimedStatus?: string;
  validateClaim?: (ticket: Ticket) => void | Promise<void>;
  journalWrite?: (pending: unknown) => () => void;
}

export interface TrackerConnection {
  instance: string;
  owner(): Promise<ActorRef>;
  tracker(options?: TrackerOptions): Tracker;
}

export interface RegisteredTracker {
  name: string;
  label: string;
  setting: "jira_site" | "github_repo";
  signIn(services: RuntimeServices): TrackerSignIn;
  instance(site: string): string;
  siteOf?(instance: string): string;
  namespace(key: string): string | undefined;
  connect(services: RuntimeServices, site: string, namespace: string): Promise<TrackerConnection>;
}

const CANONICAL_KEY = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;

const jira: RegisteredTracker = {
  name: "jira",
  label: "Jira",
  setting: "jira_site",
  signIn: (services) => jiraSignIn(services.signIn?.http),
  instance: (site) => new URL(site).hostname.replace(/\.atlassian\.net$/, ""),
  namespace: (key) => (CANONICAL_KEY.test(key) ? key.slice(0, key.lastIndexOf("-")) : undefined),
  async connect(services, site, namespace) {
    const origin = new URL(site).origin;
    const injected = services.execution?.jira;
    if (!injected && process.env.JIRA_SITE && new URL(process.env.JIRA_SITE).origin !== origin)
      throw new Error("JIRA_SITE does not match the configured Jira site");
    const signIn = jiraSignIn(services.signIn?.http);
    const transport =
      injected ??
      jiraBasicAuthTransport(
        { site: origin, ...(await requireCredentials(services, jira, signIn, origin)) },
        services.signIn?.http,
      );
    const instance = jira.instance(site);
    return {
      instance,
      owner: async () => {
        const result = await transport.request("GET", "/rest/api/3/myself");
        if (result.status === 401)
          throw new Error(
            "Jira rejected the credentials (401); run interlock login jira or update JIRA_API_TOKEN",
          );
        const parsed = z.object({ accountId: actorRefSchema }).safeParse(result.body);
        if (result.status !== 200 || !parsed.success)
          throw new Error("Jira myself discovery failed");
        return parsed.data.accountId;
      },
      tracker: (options = {}) =>
        new JiraTrackerAdapter({
          instance,
          namespace,
          transport,
          ...options,
        }),
    };
  },
};

export const TRACKERS: readonly RegisteredTracker[] = [jira, githubIssues];

export function trackerAccount(
  entry: RegisteredTracker,
  services: RuntimeServices,
): TrackerAccount {
  return {
    name: entry.name,
    label: entry.label,
    setting: entry.setting,
    signIn: entry.signIn(services),
  };
}

export function trackerNamed(name: string | undefined): RegisteredTracker | undefined {
  return TRACKERS.find((entry) => entry.name === name);
}

export type TrackerSettings = { [K in RegisteredTracker["setting"]]?: string | undefined };

export function configuredTracker(settings: TrackerSettings): {
  entry: RegisteredTracker;
  site: string | undefined;
} {
  const entry = TRACKERS.find((item) => settings[item.setting]) ?? jira;
  return { entry, site: settings[entry.setting] };
}

export function siteUnknown(entry: RegisteredTracker): Error {
  return new Error(
    `${entry.label} site is unknown; run interlock login ${entry.name} or interlock config edit --set ${entry.setting} URL`,
  );
}

export function ticketRef(entry: RegisteredTracker, instance: string, key: string): TicketRef {
  return ticketRefSchema.parse(`${entry.name}:${instance}:${entry.namespace(key)}:ticket:${key}`);
}

export function mapRef(entry: RegisteredTracker, site: string, key: string): MapRef {
  return mapRefSchema.parse(
    `${entry.name}:${entry.instance(site)}:${entry.namespace(key)}:map:${key}`,
  );
}

export function trackerOf(ref: TicketRef | MapRef): RegisteredTracker | undefined {
  return trackerNamed(parseRef(ref).adapter);
}
