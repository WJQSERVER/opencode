export * as App from "./app.js"

import { Context, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

export interface Info {
  readonly name: string
  readonly version: string
  readonly channel: string
}

export class Service extends Context.Service<Service, Info>()("@opencode/App") {}

export function make(input: Partial<Info> = {}): Info {
  return {
    name: input.name ?? "opencode",
    version: input.version ?? "unknown",
    channel: input.channel ?? "unknown",
  }
}

// A fork revision (2.2.6-u2) never reaches the wire: requests identify as the official release the
// fork builds on, so providers see the same user agent an official build sends. This mirrors the
// strip in packages/cli/script/build.ts, which bakes the default UA into the binary.
export function useragent(app: Info) {
  return `opencode/${app.channel}/${app.version.replace(/-u\d+$/, "")}/${app.name}`
}

export const layer = (input?: Partial<Info>) => Layer.succeed(Service, make(input))

export const configured = (input?: Partial<Info>) =>
  makeGlobalNode({ service: Service, layer: layer(input), deps: [] })

export const node = configured()
