import { z } from "zod";
import type { HttpTransport } from "../adapters/trackers/http.ts";
import type { UserSettingKey } from "../configuration/schema.ts";
import type { TokenSignIn, TrackerSignIn } from "../domain/tracker/port.ts";
import { withStore } from "../app/command-store.ts";
import { type CredentialStore, osCredentialStore } from "../persistence/credential-store.ts";
import type { RuntimeServices } from "../app/runtime-services.ts";
import { processTerminal, type Terminal } from "./terminal.ts";
import { storedUserSettings } from "../configuration/store.ts";

export interface SignInPlatform {
  credentials?: CredentialStore;
  terminal?: Terminal;
  http?: HttpTransport;
  environment?: Record<string, string | undefined>;
}

export interface TrackerAccount {
  name: string;
  label: string;
  setting: UserSettingKey;
  signIn: TrackerSignIn;
}

export function signInPlatform(services: RuntimeServices) {
  return {
    store: services.signIn?.credentials ?? osCredentialStore(),
    terminal: services.signIn?.terminal ?? processTerminal,
    environment: services.signIn?.environment ?? process.env,
  };
}

export function credentialName(tracker: string, site: string): string {
  return `${tracker}:${new URL(site).host}`;
}

export function savedSite(services: RuntimeServices, account: TrackerAccount): string | undefined {
  const { signIn, setting } = account;
  const variable =
    signIn.kind === "token" ? signInPlatform(services).environment[signIn.site.environment] : "";
  if (variable && signIn.kind === "token") return signIn.site.parse(variable);
  const stored = withStore(services, (store) => storedUserSettings(store)[setting]);
  return typeof stored === "string" ? stored : undefined;
}

const storedSchema = z.record(z.string(), z.string());

function storedCredentials(raw: string | undefined): Record<string, string> {
  if (raw === undefined) return {};
  try {
    return storedSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error("Stored credentials are unreadable; run interlock login again");
  }
}

export async function lookupCredentials<C extends Record<string, string>>(
  services: RuntimeServices,
  tracker: string,
  adapter: TokenSignIn<C>,
  site: string,
) {
  const { store, environment } = signInPlatform(services);
  const stored = adapter.fields.every((field) => environment[field.environment])
    ? {}
    : storedCredentials(await store.read(credentialName(tracker, site)));
  const values: Record<string, string> = {};
  const sources = new Set<"environment" | "credential store">();
  const missing: string[] = [];
  for (const field of adapter.fields) {
    const variable = environment[field.environment];
    const value = variable || stored[field.name];
    if (variable) sources.add("environment");
    else if (value) sources.add("credential store");
    if (value) values[field.name] = field.normalize?.(value) ?? value;
    else missing.push(field.environment);
  }
  const parsed = adapter.credentials.safeParse(values);
  return parsed.success
    ? { credentials: parsed.data, sources: [...sources], missing }
    : { credentials: undefined, sources: [...sources], missing };
}

export async function requireCredentials<C extends Record<string, string>>(
  services: RuntimeServices,
  account: Pick<TrackerAccount, "name" | "label">,
  adapter: TokenSignIn<C>,
  site: string,
): Promise<C> {
  const { credentials, missing } = await lookupCredentials(services, account.name, adapter, site);
  if (!credentials)
    throw new Error(
      `Not signed in to ${account.label} at ${site}; run interlock login ${account.name} or set ${missing.join(" and ")}`,
    );
  return credentials;
}

export async function storeCredentials(
  services: RuntimeServices,
  name: string,
  credentials: Record<string, string> | undefined,
): Promise<void> {
  const { store } = signInPlatform(services);
  const secret = credentials === undefined ? undefined : JSON.stringify(credentials);
  if (secret === undefined) await store.delete(name);
  else await store.write(name, secret);
  if ((await store.read(name)) !== secret)
    throw new Error(
      secret === undefined
        ? "The OS credential store still holds the credentials"
        : "The OS credential store did not keep the credentials",
    );
}
