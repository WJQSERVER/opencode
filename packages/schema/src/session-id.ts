import { Schema } from "effect"
import { descending } from "./identifier"
import { statics } from "./schema"

export const SessionID = Schema.String.check(Schema.isStartsWith("ses")).pipe(
  Schema.brand("SessionID"),
  statics((schema) => {
    const create = (suffix?: string) => schema.make("ses_" + descending(suffix))
    return {
      create,
      descending: (id?: string, suffix?: string) => (id === undefined ? create(suffix) : schema.make(id)),
    }
  }),
)
export type SessionID = typeof SessionID.Type
