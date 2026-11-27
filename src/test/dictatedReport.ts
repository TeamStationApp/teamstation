/**
 * How a dictated-play fixture reports a play: as GETs of `timeline` beside
 * the page, the report's JSON in parts small enough for a request line, for
 * a test that reads what the stack's pages stand-in was asked
 * (`e2e/rigs/scoring/fixturePage.ts`). The parts go one after another, so
 * they arrive in order; the report is also kept on the page, by name, as
 * `dictatedReports`.
 */
export const PART = 2000

export function reportParts(
  name: string,
  report: unknown,
  send: string
): string[] {
  const text = JSON.stringify(report)
  const of = Math.max(1, Math.ceil(text.length / PART))
  const parts: string[] = []
  for (let part = 0; part < of; part++) {
    const query = new URLSearchParams({
      name,
      send,
      part: String(part),
      of: String(of),
      data: text.slice(part * PART, (part + 1) * PART)
    })
    parts.push(`timeline?${query.toString()}`)
  }
  return parts
}

export async function sendReport(
  name: string,
  report: unknown,
  get: (url: string) => Promise<unknown> = async url => await fetch(url)
): Promise<void> {
  const kept = globalThis as { dictatedReports?: Record<string, unknown> }
  kept.dictatedReports = { ...kept.dictatedReports, [name]: report }
  const send = Math.random().toString(36).slice(2, 10)
  for (const url of reportParts(name, report, send)) await get(url)
}
