import {
  normalizeTag,
  type TagChoices,
  type TagDocument,
  withTargetTags
} from '../../common/eventTags'

/** The development scoring store uses the same account and assignment rules. */
export class LocalEventTags {
  private writeRevision = 0
  get revision(): string {
    return String(this.writeRevision)
  }

  private readonly catalog = new Set<string>()
  private readonly history = new Map<string, string[]>()
  private readonly assignments = new Map<
    string,
    { tag: string; userId: string }
  >()

  choices(userId: string, includeUnused = false): TagChoices {
    const counts = new Map<string, number>()
    if (includeUnused) for (const tag of this.catalog) counts.set(tag, 0)
    for (const { tag } of this.assignments.values())
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    return {
      recent: (this.history.get(userId) ?? []).slice(0, 10),
      popular: [...counts]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) =>
          a.count === b.count ? a.tag.localeCompare(b.tag) : b.count - a.count
        )
        .slice(0, includeUnused ? undefined : 30)
    }
  }

  save(
    userId: string,
    gameId: string,
    targetId: string,
    input: string | null
  ): string | null {
    const key = `${gameId}/${targetId}`
    if (input === null) {
      this.writeRevision++
      this.assignments.delete(key)
      return null
    }
    const tag = normalizeTag(input)
    this.writeRevision++
    this.catalog.add(tag)
    const previous = this.assignments.get(key)
    if (previous?.tag !== tag || previous.userId !== userId) {
      this.assignments.set(key, { tag, userId })
    }
    this.history.set(userId, [
      tag,
      ...(this.history.get(userId) ?? []).filter(value => value !== tag)
    ])
    return tag
  }

  retain(gameId: string, targetIds: string[]): void {
    const valid = new Set(targetIds.map(id => `${gameId}/${id}`))
    for (const key of this.assignments.keys())
      if (key.startsWith(`${gameId}/`) && !valid.has(key))
        this.assignments.delete(key)
  }

  decorate<T extends TagDocument>(gameId: string, play: T): T {
    const labels = new Map<string, string>()
    for (const [key, { tag }] of this.assignments)
      if (key.startsWith(`${gameId}/`))
        labels.set(key.slice(gameId.length + 1), tag)
    return withTargetTags(play, labels)
  }
}
