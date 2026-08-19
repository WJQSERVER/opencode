const length = 26
const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let lastTimestamp = 0
let counter = 0

export function ascending(suffix?: string) {
  return create(false, Date.now(), suffix)
}

export function descending(suffix?: string) {
  return create(true, Date.now(), suffix)
}

export function create(descending: boolean, timestamp = Date.now(), suffix?: string) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++

  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const value = descending ? ~current : current
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("")
  const bytes = crypto.getRandomValues(new Uint8Array(length - 12))
  const result = time + Array.from(bytes, (byte) => chars[byte % 62]).join("")
  if (!suffix) return result
  return result.slice(0, -suffix.length) + suffix
}
