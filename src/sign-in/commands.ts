import { z } from "zod";
import { defineAction } from "../app/action.ts";
import { withStore } from "../app/command-store.ts";
import type { RuntimeServices } from "../app/runtime-services.ts";
import {
  credentialName,
  savedSite,
  signInPlatform,
  storeCredentials,
  type TrackerAccount,
} from "./credentials.ts";
import { type RegisteredTracker, TRACKERS, trackerAccount } from "../app/tracker/registry.ts";
import { saveUserSetting } from "../configuration/store.ts";

export function signInActions(services: RuntimeServices) {
  const actions = (
    describe: (entry: RegisteredTracker) => string,
    handler: (entry: RegisteredTracker) => Promise<string>,
  ) =>
    Object.fromEntries(
      TRACKERS.map((entry) => [
        entry.name,
        defineAction({
          description: describe(entry),
          input: {},
          result: z.string(),
          handler: () => handler(entry),
        }),
      ]),
    );
  return {
    login: actions(
      (entry) => `Sign in to ${entry.label} and keep the credentials in the OS credential store.`,
      (entry) => login(services, trackerAccount(entry, services)),
    ),
    logout: actions(
      (entry) => `Remove ${entry.label} credentials from the OS credential store.`,
      (entry) => logout(services, trackerAccount(entry, services)),
    ),
  };
}

async function login(services: RuntimeServices, account: TrackerAccount): Promise<string> {
  const { label, setting, signIn: adapter, name: tracker } = account;
  if (adapter.kind === "none") return `${label} needs no sign-in.`;
  if (adapter.kind === "external_cli")
    return `Signed in to ${label} through ${adapter.command} as ${(await adapter.verify()).name}.`;
  const { terminal } = signInPlatform(services);
  if (!terminal.interactive())
    throw new Error(
      `interlock login ${tracker} needs an interactive terminal; set ${[adapter.site, ...adapter.fields].map((field) => field.environment).join(", ")} for headless use`,
    );
  const site = adapter.site.parse(
    await terminal.ask(adapter.site.label, {
      hidden: false,
      default: savedSite(services, account),
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
  const verified = await adapter.verify(site, parsed.data);
  await storeCredentials(services, credentialName(tracker, site), parsed.data);
  withStore(services, (store) => saveUserSetting(store, setting, site));
  return `Signed in to ${label} at ${site} as ${verified.name}.`;
}

async function logout(services: RuntimeServices, account: TrackerAccount): Promise<string> {
  const { label, signIn } = account;
  if (signIn.kind === "none") return `${label} needs no sign-in.`;
  if (signIn.kind === "external_cli") return `Sign out of ${label} through ${signIn.command}.`;
  const site = savedSite(services, account);
  if (!site) return `Not signed in to ${label}.`;
  await storeCredentials(services, credentialName(account.name, site), undefined);
  return `Signed out of ${label} at ${site}.`;
}
