import { z } from "zod";
import { defineAction } from "../cli/definition.ts";
import { withStore } from "../persistence/command-store.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import {
  credentialName,
  savedSite,
  signInPlatform,
  storeCredentials,
  type TrackerName,
  trackerSignIns,
} from "./credentials.ts";

export function signInActions(services: RuntimeServices) {
  return {
    login: {
      jira: defineAction({
        description: "Sign in to Jira and keep the credentials in the OS credential store.",
        input: {},
        result: z.string(),
        handler: () => login(services, "jira"),
      }),
    },
    logout: {
      jira: defineAction({
        description: "Remove Jira credentials from the OS credential store.",
        input: {},
        result: z.string(),
        handler: () => logout(services, "jira"),
      }),
    },
  };
}

async function login(services: RuntimeServices, tracker: TrackerName): Promise<string> {
  const { label, setting, adapter } = trackerSignIns(services)[tracker];
  const { terminal } = signInPlatform(services);
  if (!terminal.interactive())
    throw new Error(
      `interlock login ${tracker} needs an interactive terminal; set ${[adapter.site, ...adapter.fields].map((field) => field.environment).join(", ")} for headless use`,
    );
  const site = adapter.site.parse(
    await terminal.ask(adapter.site.label, {
      hidden: false,
      default: savedSite(services, tracker),
    }),
  );
  terminal.say(`Create an API token at ${adapter.tokenPage}`);
  terminal.open(adapter.tokenPage);
  const values: Record<string, string> = {};
  for (const field of adapter.fields) {
    const answer = await terminal.ask(field.label, { hidden: field.hidden });
    values[field.name] = field.normalize?.(answer) ?? answer.trim();
  }
  const parsed = adapter.credentials.safeParse(values);
  if (!parsed.success) throw new Error(`${label} sign-in needs every credential field`);
  const account = await adapter.verify(site, parsed.data);
  await storeCredentials(services, credentialName(tracker, site), parsed.data);
  withStore(services, (store) => store.saveUserSetting(setting, site));
  return `Signed in to ${label} at ${site} as ${account.name}.`;
}

async function logout(services: RuntimeServices, tracker: TrackerName): Promise<string> {
  const { label } = trackerSignIns(services)[tracker];
  const site = savedSite(services, tracker);
  if (!site) return `Not signed in to ${label}.`;
  await storeCredentials(services, credentialName(tracker, site), undefined);
  return `Signed out of ${label} at ${site}.`;
}
