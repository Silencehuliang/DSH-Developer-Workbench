/**
 * Stage derivation: which step of the workflow a project is on, and why.
 *
 * Pure by construction. It reads no disk, calls no CLI, and takes every fact as
 * an argument, so the interesting cases — an empty project, a spec with no
 * tracker, tickets all finished — are ordinary function calls in a test.
 *
 * The stage is *derived*, never a field somebody maintains. That is the whole
 * point: a state the user has to keep in step with reality drifts away from it.
 * A manual override exists, and is reported separately from the derivation so a
 * reader can always see which of the two they are looking at.
 *
 * @module lib/stage
 */

/** The pipeline, in order. Labels live in the UI; ids are the contract. */
export const STAGES = [
  { id: 'setup', skill: 'setup-matt-pocock-skills' },
  { id: 'grill', skill: 'grilling', alternative: 'grill-with-docs' },
  { id: 'spec', skill: 'to-spec' },
  { id: 'tickets', skill: 'to-tickets' },
  { id: 'implement', skill: 'implement', alternative: 'tdd' },
  { id: 'review', skill: 'code-review' },
  { id: 'pr', skill: 'pr' },
  { id: 'retro', skill: 'retro' },
]

/**
 * Ticket count above which the work no longer fits one agent session, so the
 * wayfinder map is the better next move than another ticket.
 *
 * A heuristic, and exposed in the result as such rather than buried: the caller
 * may override it, and the UI says which number produced the suggestion.
 */
export const WAYFINDER_TICKET_THRESHOLD = 12

/** Coerce a possibly-missing count to a non-negative integer. */
function count(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** Index of a stage id, or -1. */
function indexOfStage(id) {
  return STAGES.findIndex((stage) => stage.id === id)
}

/**
 * Derive the current stage.
 *
 * Key inference: **tickets imply a spec**. `to-tickets` consumes a spec, so a
 * tracker holding tickets is proof that the spec step happened even when the
 * spec itself lives somewhere this module cannot see (an issue tracker, a
 * document outside the scanned roots).
 *
 * @param facts - everything the derivation is allowed to know.
 * @param facts.tracker - the resolved tracker, or null when none is declared.
 * @param facts.specCount - spec documents found in the project.
 * @param facts.planCount - wayfinder-style planning maps found in the project.
 * @param facts.adrCount - ADR documents.
 * @param facts.glossaryCount - glossary documents.
 * @param facts.ticketTotal - tickets on the tracker.
 * @param facts.ticketDone - tickets whose status is done.
 * @param facts.frontierCount - tickets with every blocker resolved.
 * @param facts.reviewCount - recorded review artifacts.
 * @param facts.prCount - recorded pull requests.
 * @param facts.override - a stage id the user pinned, if any.
 * @param facts.wayfinderThreshold - override for the wayfinder heuristic.
 * @returns the derivation: current stage, what is complete, why, and any bypass.
 */
export function deriveStage(facts = {}) {
  const tracker = facts.tracker ?? null
  const specCount = count(facts.specCount)
  const planCount = count(facts.planCount)
  const adrCount = count(facts.adrCount)
  const glossaryCount = count(facts.glossaryCount)
  const ticketTotal = count(facts.ticketTotal)
  const ticketDone = Math.min(count(facts.ticketDone), ticketTotal)
  const frontierCount = count(facts.frontierCount)
  const reviewCount = count(facts.reviewCount)
  const prCount = count(facts.prCount)
  const threshold = Number.isFinite(facts.wayfinderThreshold) && facts.wayfinderThreshold > 0
    ? Math.floor(facts.wayfinderThreshold)
    : WAYFINDER_TICKET_THRESHOLD

  const openTickets = ticketTotal - ticketDone
  // `to-tickets` consumes a spec, so existing tickets prove the spec step ran
  // even when the spec is not a file this project can show.
  const specPresent = specCount + planCount > 0 || ticketTotal > 0
  const designDocs = adrCount + glossaryCount

  const evidence = []
  let derived

  // Every evidence item carries the numbers behind its sentence in `data`, so a
  // caller can render the same fact in another language without re-deriving it —
  // and without parsing the English prose. `note` stays as the fallback for any
  // code the caller has no wording for.
  if (tracker === null) {
    derived = 'setup'
    evidence.push({ stage: 'setup', code: 'no-tracker', note: 'no tracker is declared for this project', data: {} })
  } else if (!specPresent) {
    if (designDocs === 0) {
      derived = 'grill'
      evidence.push({ stage: 'grill', code: 'nothing-sharpened', note: 'no spec and no design docs exist yet', data: {} })
    } else {
      derived = 'spec'
      evidence.push({ stage: 'spec', code: 'design-docs-only', note: `${designDocs} design doc(s) exist but no spec yet`, data: { designDocs } })
    }
  } else if (ticketTotal === 0) {
    derived = 'tickets'
    evidence.push({
      stage: 'tickets',
      code: specCount + planCount > 0 ? 'spec-without-tickets' : 'tickets-absent',
      note: specCount + planCount > 0
        ? 'a spec exists but the tracker holds no tickets'
        : 'the tracker holds no tickets yet',
      data: { specCount, planCount },
    })
  } else if (openTickets > 0) {
    derived = 'implement'
    evidence.push({
      stage: 'implement',
      code: 'tickets-open',
      note: `${openTickets} of ${ticketTotal} ticket(s) are still open, ${frontierCount} startable`,
      data: { openTickets, ticketTotal, frontierCount },
    })
  } else if (reviewCount === 0) {
    derived = 'review'
    evidence.push({ stage: 'review', code: 'no-review', note: `all ${ticketTotal} ticket(s) are done and no review is recorded`, data: { ticketTotal } })
  } else if (prCount === 0) {
    derived = 'pr'
    evidence.push({ stage: 'pr', code: 'no-pull-request', note: 'a review is recorded and there is no pull request yet', data: {} })
  } else {
    derived = 'retro'
    evidence.push({ stage: 'retro', code: 'delivered', note: `${prCount} pull request(s) recorded`, data: { prCount } })
  }

  const override = typeof facts.override === 'string' && indexOfStage(facts.override) >= 0 ? facts.override : null
  const stage = override ?? derived
  const stageIndex = indexOfStage(stage)

  const bypass = []
  if (openTickets >= threshold) {
    bypass.push({
      skill: 'wayfinder',
      code: 'too-many-open-tickets',
      note: `${openTickets} open tickets is at or above the ${threshold}-ticket threshold for one session`,
      data: { openTickets, threshold },
    })
  }
  if (planCount > 0 && ticketTotal === 0) {
    bypass.push({
      skill: 'to-tickets',
      code: 'map-without-tickets',
      note: 'a planning map exists but no tickets have been cut from it yet',
      data: { planCount },
    })
  }

  return {
    stage,
    derived,
    /** True whenever a pin exists, so the UI can label it without comparing ids. */
    overridden: override !== null,
    completed: STAGES.slice(0, stageIndex < 0 ? 0 : stageIndex).map((entry) => entry.id),
    evidence,
    bypass,
    facts: {
      tracker: tracker === null ? null : tracker.kind,
      specCount,
      planCount,
      adrCount,
      glossaryCount,
      ticketTotal,
      ticketDone,
      openTickets,
      frontierCount,
      reviewCount,
      prCount,
      wayfinderThreshold: threshold,
    },
  }
}
