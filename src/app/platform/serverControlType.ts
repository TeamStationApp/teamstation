/** Keeps another server for the next launch (null for this build's own), answering the host kept. */
export type ServerControl = (origin: string | null) => Promise<string | null>
