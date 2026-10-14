/**
 * The workbench's HTTP surface.
 *
 * Every route is owned by this module and registered by `index.js`, so the
 * browser half talks to exactly one contract and the host half has exactly one
 * place where inputs become responses. Handlers own the full response life
 * cycle; nothing here throws past a handler boundary.
 *
 * @module lib/routes
 */

import fs from 'node:fs'
import path from 'node:path'

import { readArtifactPreview, scanArtifacts } from './artifacts.js'
import { nextHandoffPath } from './handoffs.js'
import { describeProject, probeDirectory } from './projects.js'
import { PROMPT_STAGES, buildDispatchPrompt, findDispatchable, readTriageLabels } from './prompts.js'
import { PROMPT_LANGUAGES, SETTINGS_DEFAULTS, WAYFINDER_RANGE, normalizeSettings, resolvePromptLanguage } from './settings.js'
import { STAGES, deriveStage } from './stage.js'
import { analyseBoard, createCommandRunner, readGitHubTickets, readLocalTickets, resolveGitHubRepo } from './tickets.js'
import { readSkillInventory, reconcileSkills } from './skills.js'
import { projectKey } from './state.js'
import { TRACKER_KINDS, TRACKER_LABELS, resolveTracker } from './tracker.js'

/** Base path of every route this plugin owns. */
export const ROUTE_BASE = '/api/developer-workbench'

/** Largest request body accepted, in bytes. */
const BODY_LIMIT = 64 * 1024

/**
 * Send one JSON response.
 * @param res - the response to own and finish.
 * @param status - HTTP status code.
 * @param body - JSON-serialisable payload.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

/**
 * Read and parse a JSON request body.
 * @param req - the incoming request.
 * @returns the parsed body (an empty object when the body is empty).
 * @throws when the body is too large or is not JSON.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        fail(new Error('request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text.length === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch (error) {
        reject(new Error('request body is not JSON'))
      }
    })
    req.on('error', fail)
  })
}

/**
 * Read one query parameter.
 * @param req - the incoming request.
 * @param name - the parameter name.
 * @returns the value, or null when absent or empty.
 */
function queryParam(req, name) {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const value = url.searchParams.get(name)
    return value === null || value.trim().length === 0 ? null : value
  } catch (error) {
    return null
  }
}

/**
 * Build every route this plugin serves.
 *
 * @param options - wiring.
 * @param options.ctx - host context, used to reach the workspace registry.
 * @param options.store - the workbench state store.
 * @param options.info - static identity and paths reported by `/health`.
 * @param options.now - clock, injectable for tests.
 * @returns route descriptors accepted by the web carrier.
 */
export function buildRoutes({ ctx, store, info, now = () => new Date(), run = createCommandRunner() }) {
  /** Resolve the registry lazily so a missing service degrades instead of throwing. */
  const registry = () => (typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined)

  /** Uniform failure for a handler that could not do its job. */
  const fail = (res, status, error) => sendJson(res, status, { error: String(error?.message ?? error) })

  const health = {
    kind: 'exact',
    path: `${ROUTE_BASE}/health`,
    handler: (req, res) => {
      const skills = readSkillInventory(info.skillsDir)
      sendJson(res, 200, {
        name: info.name,
        version: info.version,
        packageDir: info.packageDir,
        skillsDir: info.skillsDir,
        dataDir: info.dataDir,
        stateFile: store.file,
        pid: process.pid,
        skills: skills.length,
        skillProblems: skills.filter((row) => row.problems.length > 0).length,
      })
    },
  }

  const skills = {
    kind: 'exact',
    path: `${ROUTE_BASE}/skills`,
    handler: (req, res) => {
      const rows = readSkillInventory(info.skillsDir)
      sendJson(res, 200, {
        total: rows.length,
        modelInvocable: rows.filter((row) => row.modelInvocable).length,
        userInvocable: rows.filter((row) => row.userInvocable).length,
        withProblems: rows.filter((row) => row.problems.length > 0).length,
        skills: rows,
      })
    },
  }

  const overview = {
    kind: 'exact',
    path: `${ROUTE_BASE}/overview`,
    handler: async (req, res) => {
      try {
        const workspaces = registry()?.list() ?? []
        // Projects are independent reads, so one round of waiting rather than one
        // per workspace. Serially each git query added its own latency.
        const projects = await Promise.all(
          workspaces.map((workspace) => describeProject({ workspace, state: store })),
        )
        sendJson(res, 200, {
          generatedAt: now().toISOString(),
          stateFile: store.file,
          workspaceCount: workspaces.length,
          projects,
        })
      } catch (error) {
        fail(res, 500, error)
      }
    },
  }

  const probe = {
    kind: 'exact',
    path: `${ROUTE_BASE}/probe`,
    handler: async (req, res) => {
      try {
        const target = queryParam(req, 'path')
        if (target === null) {
          sendJson(res, 400, { error: 'path is required' })
          return
        }
        const resolved = path.resolve(target)
        const mapping = store.get(projectKey(resolved))?.tracker ?? null
        sendJson(res, 200, await probeDirectory({ target: resolved, mapping }))
      } catch (error) {
        fail(res, 500, error)
      }
    },
  }

  const bind = {
    kind: 'exact',
    path: `${ROUTE_BASE}/projects/bind`,
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const raw = typeof body.path === 'string' ? body.path.trim() : ''
        if (raw.length === 0) {
          sendJson(res, 400, { error: 'path is required' })
          return
        }
        const target = path.resolve(raw)
        const workspaces = registry()
        if (workspaces === undefined) {
          sendJson(res, 503, { error: 'the workspace registry is unavailable' })
          return
        }

        let workspace
        try {
          workspace = await workspaces.create(target, typeof body.title === 'string' ? body.title : undefined)
        } catch (error) {
          sendJson(res, 400, { error: `cannot bind this directory: ${String(error?.message ?? error)}` })
          return
        }

        const key = projectKey(workspace.path)
        const existing = store.get(key)?.tracker ?? null
        const tracker = resolveTracker({ projectPath: workspace.path, mapping: existing })
        const decidedAt = now().toISOString()

        if (tracker !== null && tracker.conflict === null) {
          store.upsert(key, {
            path: workspace.path,
            workspaceId: workspace.id,
            tracker: { kind: tracker.kind, decidedAt, source: tracker.source },
          })
        } else {
          // Either nothing decided it, or the persisted choice disagrees with the
          // project's own declaration. Both need the user; neither may be guessed.
          store.upsert(key, { path: workspace.path, workspaceId: workspace.id })
        }

        sendJson(res, 200, {
          project: await describeProject({ workspace, state: store }),
          needsChoice: tracker === null || tracker.conflict !== null,
          conflict: tracker?.conflict ?? null,
          trackerSource: tracker?.source ?? null,
        })
      } catch (error) {
        fail(res, 500, error)
      }
    },
  }

  const setTracker = {
    kind: 'exact',
    path: `${ROUTE_BASE}/projects/tracker`,
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const raw = typeof body.path === 'string' ? body.path.trim() : ''
        const kind = typeof body.kind === 'string' ? body.kind.trim() : ''
        if (raw.length === 0 || kind.length === 0) {
          sendJson(res, 400, { error: 'path and kind are required' })
          return
        }
        if (!TRACKER_KINDS.includes(kind)) {
          sendJson(res, 400, { error: `unknown tracker kind: ${kind}`, accepted: TRACKER_KINDS })
          return
        }
        const workspaces = registry()
        if (workspaces === undefined) {
          sendJson(res, 503, { error: 'the workspace registry is unavailable' })
          return
        }
        const workspace = await workspaces.resolveByPath(path.resolve(raw))
        if (workspace === undefined) {
          sendJson(res, 404, { error: 'bind this directory before choosing its tracker' })
          return
        }
        store.upsert(projectKey(workspace.path), {
          path: workspace.path,
          workspaceId: workspace.id,
          tracker: { kind, decidedAt: now().toISOString(), source: 'user-choice' },
        })
        sendJson(res, 200, {
          project: await describeProject({ workspace, state: store }),
          label: TRACKER_LABELS[kind] ?? kind,
          needsChoice: false,
        })
      } catch (error) {
        fail(res, 500, error)
      }
    },
  }

  const unbind = {
    kind: 'exact',
    path: `${ROUTE_BASE}/projects/unbind`,
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const workspaces = registry()
        if (workspaces === undefined) {
          sendJson(res, 503, { error: 'the workspace registry is unavailable' })
          return
        }
        let workspace
        if (typeof body.workspaceId === 'string' && body.workspaceId.trim().length > 0) {
          workspace = workspaces.get(body.workspaceId.trim())
        } else if (typeof body.path === 'string' && body.path.trim().length > 0) {
          workspace = await workspaces.resolveByPath(path.resolve(body.path.trim()))
        }
        if (workspace === undefined) {
          sendJson(res, 404, { error: 'no workspace matches that project' })
          return
        }
        const removed = await workspaces.delete(workspace.id)
        // Unbinding forgets the project: a stale tracker mapping outliving its
        // workspace is exactly the kind of residue that makes the list lie.
        const forgotten = store.remove(projectKey(workspace.path))
        sendJson(res, 200, { removed, forgotten, path: workspace.path })
      } catch (error) {
        fail(res, 500, error)
      }
    },
  }

  const artifacts = {
    kind: 'exact',
    path: `${ROUTE_BASE}/artifacts`,
    handler: (req, res) => {
      try {
        const target = queryParam(req, 'path')
        if (target === null) {
          sendJson(res, 400, { error: 'path is required' })
          return
        }
        const resolved = path.resolve(target)
        // Handoffs live in the OS temp directory by the upstream skill's design,
        // so the only way to attribute one to a project is the workbench's own
        // record. An empty list simply means no handoff has been produced yet.
        const record = store.get(projectKey(resolved))
        sendJson(res, 200, scanArtifacts(resolved, { handoffs: record?.handoffs ?? [] }))
      } catch (error) {
        fail(res, 500, error)
      }
    },
  }

  const artifact = {
    kind: 'exact',
    path: `${ROUTE_BASE}/artifact`,
    handler: (req, res) => {
      try {
        const target = queryParam(req, 'path')
        if (target === null) {
          sendJson(res, 400, { error: 'path is required' })
          return
        }
        const offset = queryParam(req, 'offset')
        const limit = queryParam(req, 'limit')
        const result = readArtifactPreview(target, {
          offset: offset === null ? undefined : Number.parseInt(offset, 10),
          limit: limit === null ? undefined : Number.parseInt(limit, 10),
        })
        if (!result.ok) {
          // Refusals carry their own reason; mapping them onto statuses keeps the
          // difference between "absent" and "I will not show you this" visible.
          const status = result.code === 'missing'
            ? 404
            : result.code === 'too-large'
              ? 413
              : result.code === 'not-a-file'
                ? 400
                : 415
          sendJson(res, status, result)
          return
        }
        sendJson(res, 200, result)
      } catch (error) {
        fail(res, 500, error)
      }
    },
  }

  /**
   * Read a project's tickets through its own tracker.
   *
   * Shared by the board and the stage derivation on purpose: two readers that
   * could disagree about what the frontier is would be worse than one that is
   * occasionally wrong, because the disagreement is invisible.
   */
  const boardFor = async (resolved, tracker) => {
    if (tracker === null) {
      return { state: 'needs-tracker', tickets: [], frontier: [], problems: [], notes: [] }
    }
    if (tracker.kind === 'local-markdown') {
      const read = readLocalTickets({ projectPath: resolved })
      return { state: 'ready', ...analyseBoard(read.tickets), notes: read.notes }
    }
    if (tracker.kind === 'github') {
      const repository = await resolveGitHubRepo(resolved, run)
      if (repository === null) {
        return {
          state: 'unavailable',
          reason: { code: 'no-github-remote', message: 'this project has no GitHub remote to read issues from' },
          tickets: [],
          frontier: [],
          problems: [],
          notes: [],
        }
      }
      const read = await readGitHubTickets({ run, owner: repository.owner, repo: repository.repo })
      if (read.ok !== true) {
        return {
          state: 'unavailable',
          reason: { code: read.code, message: read.message },
          repository,
          tickets: [],
          frontier: [],
          problems: [],
          notes: [],
        }
      }
      return { state: 'ready', repository, ...analyseBoard(read.tickets), notes: read.notes }
    }
    // A tracker this build cannot read is its own state. Rendering nothing would
    // be indistinguishable from an empty, healthy board.
    return {
      state: 'unsupported',
      reason: { code: 'adapter-missing', message: `no adapter for the ${tracker.kind} tracker yet` },
      tickets: [],
      frontier: [],
      problems: [],
      notes: [],
    }
  }

  /**
   * The GitHub board: single-flight, cached, and stale-while-revalidate.
   *
   * **Only the GitHub read is cached.** It pays for a `gh api` call per issue,
   * and each `gh` invocation costs roughly a second before it has even reached
   * the network — so the whole read is bounded by *waves*, not by work. Measured
   * on this repository: 20 issues at concurrency 6 took 4.7 s, which is what made
   * every click on a project feel broken.
   *
   * Three properties make it stop costing the user time:
   *
   * - **single-flight** — opening a project asks twice (the board route and the
   *   stage route); both share one read.
   * - **cached** for {@link BOARD_TTL_MS}.
   * - **stale-while-revalidate** — past the TTL the previous value is returned
   *   *immediately* and refreshed behind the caller, so only the very first read
   *   of a project ever waits. A read that failed is evicted rather than cached.
   *
   * The local-markdown read is deliberately not cached: it is a directory
   * listing, and caching it only bought staleness — it served an empty board
   * after tickets appeared on disk, which broke the acceptance walk.
   */
  const boardCache = new Map()
  const boardRefreshing = new Set()
  const BOARD_TTL_MS = 30000

  /** Read a GitHub board and remember the value. */
  const readAndStoreBoard = (key, resolved, tracker) => {
    const promise = boardFor(resolved, tracker)
      .then((value) => {
        boardCache.set(key, { at: Date.now(), value, promise: Promise.resolve(value) })
        return value
      })
      .catch((error) => {
        boardCache.delete(key)
        throw error
      })
    boardCache.set(key, { at: Date.now(), promise })
    return promise
  }

  /** Refresh a stale entry without making the caller wait for it. */
  const refreshBoardBehind = (key, resolved, tracker) => {
    if (boardRefreshing.has(key)) return
    boardRefreshing.add(key)
    boardFor(resolved, tracker)
      .then((value) => {
        boardCache.set(key, { at: Date.now(), value, promise: Promise.resolve(value) })
      })
      .catch(() => {
        // A failed background refresh leaves the last good value in place.
      })
      .finally(() => {
        boardRefreshing.delete(key)
      })
  }

  const boardForCached = (resolved, tracker) => {
    if (tracker?.kind !== 'github') return boardFor(resolved, tracker)
    const key = `${tracker.kind}:${resolved}`
    const cached = boardCache.get(key)
    if (cached === undefined) return readAndStoreBoard(key, resolved, tracker)
    if (cached.value !== undefined) {
      if (Date.now() - cached.at >= BOARD_TTL_MS) refreshBoardBehind(key, resolved, tracker)
      return Promise.resolve(cached.value)
    }
    return cached.promise
  }

  /** Drop a cached board, so the next read sees what just changed. */
  const invalidateBoard = (resolved) => {
    for (const key of [...boardCache.keys()]) {
      if (key.endsWith(`:${resolved}`)) boardCache.delete(key)
    }
  }

  /** Count scanned artifacts by kind, which is what the stage derivation reads. */
  const artifactCounts = (scan) => {
    const counts = { spec: 0, plan: 0, adr: 0, glossary: 0, handoff: 0 }
    for (const group of scan.groups) {
      for (const item of group.items) {
        if (counts[item.kind] !== undefined) counts[item.kind] += 1
      }
    }
    return counts
  }

  const tickets = {
    kind: 'exact',
    path: `${ROUTE_BASE}/tickets`,
    handler: async (req, res) => {
      try {
        const target = queryParam(req, 'path')
        if (target === null) {
          sendJson(res, 400, { error: 'path is required' })
          return
        }
        const resolved = path.resolve(target)
        const tracker = resolveTracker({
          projectPath: resolved,
          mapping: store.get(projectKey(resolved))?.tracker ?? null,
        })
        sendJson(res, 200, { tracker, ...(await boardForCached(resolved, tracker)) })
      } catch (error) {
        fail(res, 500, error)
      }
    },
  }

  const stage = {
    kind: 'exact',
    path: `${ROUTE_BASE}/stage`,
    handler: async (req, res) => {
      try {
        const target = queryParam(req, 'path')
        if (target === null) {
          sendJson(res, 400, { error: 'path is required' })
          return
        }
        const resolved = path.resolve(target)
        const key = projectKey(resolved)
        const record = store.get(key) ?? null
        const tracker = resolveTracker({ projectPath: resolved, mapping: record?.tracker ?? null })
        const scan = scanArtifacts(resolved, { handoffs: record?.handoffs ?? [] })
        const counts = artifactCounts(scan)
        const board = await boardForCached(resolved, tracker)

        const derivation = deriveStage({
          tracker,
          specCount: counts.spec,
          planCount: counts.plan,
          adrCount: counts.adr,
          glossaryCount: counts.glossary,
          ticketTotal: (board.tickets ?? []).length,
          ticketDone: (board.tickets ?? []).filter((ticket) => ticket.statusKind === 'done').length,
          frontierCount: board.frontier?.length ?? 0,
          reviewCount: Array.isArray(record?.reviews) ? record.reviews.length : 0,
          prCount: Array.isArray(record?.pullRequests) ? record.pullRequests.length : 0,
          override: record?.stageOverride ?? null,
          // The bypass threshold is a setting, so it has to reach the derivation.
          wayfinderThreshold: normalizeSettings(store.settings()).wayfinderThreshold,
        })

        // Persist only on change: a poll must not rewrite the state file, and the
        // stored value is what the cheap `/overview` badge reads.
        const previous = record?.stage ?? null
        if (previous === null || previous.id !== derivation.stage || previous.overridden !== derivation.overridden) {
          store.upsert(key, {
            path: resolved,
            stage: { id: derivation.stage, derivedAt: now().toISOString(), overridden: derivation.overridden },
          })
        }

        sendJson(res, 200, {
          ...derivation,
          stages: STAGES,
          tracker,
          board: {
            state: board.state,
            reason: board.reason ?? null,
            repository: board.repository ?? null,
            frontier: board.frontier ?? [],
            problems: board.problems ?? [],
            notes: board.notes ?? [],
          },
          artifacts: { counts, groups: scan.groups },
        })
      } catch (error) {
        fail(res, 500, error)
      }
    },
  }

  const setStage = {
    kind: 'exact',
    path: `${ROUTE_BASE}/projects/stage`,
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const raw = typeof body.path === 'string' ? body.path.trim() : ''
        if (raw.length === 0) {
          sendJson(res, 400, { error: 'path is required' })
          return
        }
        const resolved = path.resolve(raw)
        const stageId = body.stage === null || body.stage === undefined ? null : String(body.stage)
        if (stageId !== null && !STAGES.some((entry) => entry.id === stageId)) {
          sendJson(res, 400, { error: `unknown stage: ${stageId}`, accepted: STAGES.map((entry) => entry.id) })
          return
        }
        // A pin is a patch over the derivation, not a replacement for it: the
        // derivation keeps running and keeps being reported next to the pin.
        store.upsert(projectKey(resolved), { path: resolved, stageOverride: stageId })
        sendJson(res, 200, { ok: true, stageOverride: stageId })
      } catch (error) {
        fail(res, 500, error)
      }
    },
  }

  const prompt = {
    kind: 'exact',
    path: `${ROUTE_BASE}/prompt`,
    handler: async (req, res) => {
      try {
        const target = queryParam(req, 'path')
        const stageId = queryParam(req, 'stage')
        if (target === null || stageId === null) {
          sendJson(res, 400, { error: 'path and stage are required' })
          return
        }
        const entry = findDispatchable(stageId)
        if (entry === undefined) {
          sendJson(res, 400, { error: `unknown stage: ${stageId}`, accepted: PROMPT_STAGES })
          return
        }

        const resolved = path.resolve(target)
        const record = store.get(projectKey(resolved)) ?? null
        const tracker = resolveTracker({ projectPath: resolved, mapping: record?.tracker ?? null })
        const board = await boardForCached(resolved, tracker)

        // The implement step needs a subject. Default to the first startable
        // ticket, which is the same answer the board gives.
        let ticket = null
        if (entry.id === 'implement') {
          const wanted = queryParam(req, 'ticket') ?? (board.frontier ?? [])[0] ?? null
          if (wanted !== null) ticket = (board.tickets ?? []).find((row) => row.id === String(wanted)) ?? null
        }

        const workspaces = registry()?.list() ?? []
        const workspace = workspaces.find((candidate) => path.resolve(candidate.path) === resolved) ?? null
        const title = workspace?.title ?? path.basename(resolved)

        // Handoff documents are the one artifact whose path the workbench must
        // choose itself: the temp directory has no per-project structure, and the
        // upstream skill prescribes no file name — so nothing else could list it.
        let handoffPath = null
        if (entry.id === 'handoff') {
          handoffPath = nextHandoffPath(resolved)
        } else if (entry.id === 'resume') {
          const wanted = queryParam(req, 'handoff')
          if (wanted === null) {
            sendJson(res, 400, { error: 'resuming a handoff needs its path' })
            return
          }
          handoffPath = path.resolve(wanted)
        }
        const handoffExists = handoffPath === null ? null : fs.existsSync(handoffPath)

        const built = buildDispatchPrompt({
          stage: entry,
          skillsDir: info.skillsDir,
          tracker,
          repository: board.repository ?? null,
          project: { path: resolved, title },
          ticket,
          triageLabels: readTriageLabels(resolved),
          handoffPath,
          // The prompt follows the interface unless the user pinned a language —
          // and the client reports its locale as `lang`.
          lang: resolvePromptLanguage(normalizeSettings(store.settings()).promptLanguage, queryParam(req, 'lang')),
        })

        sendJson(res, 200, {
          ...built,
          targets: {
            // Either coordinate creates a session; workspaceId is preferred and
            // cwd is the fallback for a directory that was never bound.
            project: { path: resolved, title, workspaceId: workspace?.id ?? null },
            tracker,
            repository: board.repository ?? null,
            ticket: ticket === null ? null : { id: ticket.id, title: ticket.title, url: ticket.url ?? null },
            handoff: handoffPath === null ? null : { path: handoffPath, exists: handoffExists },
            board: { state: board.state, frontier: board.frontier ?? [] },
          },
        })
      } catch (error) {
        fail(res, 500, error)
      }
    },
  }

  const skillStatus = {
    kind: 'exact',
    path: `${ROUTE_BASE}/skills/status`,
    handler: async (req, res) => {
      try {
        const target = queryParam(req, 'path')
        const cwd = target === null ? undefined : path.resolve(target)
        const onDisk = readSkillInventory(info.skillsDir)

        /**
         * The payload shape when the catalog cannot be consulted at all.
         *
         * Rows come back `unknown`, never `not-discovered`: "I could not look" is
         * a different claim from "I looked and it was not there", and conflating
         * them is exactly the failure this surface exists to prevent.
         */
        const unavailable = (code, message) => ({
          state: 'unavailable',
          reason: { code, message },
          complete: null,
          counts: {
            total: onDisk.length,
            discovered: 0,
            notDiscovered: onDisk.length,
            invalid: onDisk.filter((row) => row.problems.length > 0).length,
            modelInvocable: onDisk.filter((row) => row.modelInvocable).length,
            humanOnly: onDisk.filter((row) => !row.modelInvocable).length,
          },
          rows: onDisk.map((row) => ({ ...row, status: 'unknown' })),
          otherSkills: [],
          diagnosis: {
            code: 'catalog-unavailable',
            hint: '读不到 DSH 的技能目录，所以无法判断这些技能到底能不能被会话加载 —— 这不等于是「缺失」。',
          },
        })

        const service = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
        if (service === undefined) {
          sendJson(res, 200, unavailable('skills-service-missing', 'the host skill registry is not available in this composition'))
          return
        }

        let snapshot
        try {
          snapshot = await service.snapshot(cwd === undefined ? {} : { cwd })
        } catch (error) {
          sendJson(res, 200, unavailable('snapshot-failed', String(error?.message ?? error)))
          return
        }

        sendJson(res, 200, {
          state: 'ready',
          cwd: cwd ?? null,
          ...reconcileSkills({
            onDisk,
            catalog: snapshot?.skills ?? [],
            complete: snapshot?.complete !== false,
          }),
        })
      } catch (error) {
        fail(res, 500, error)
      }
    },
  }

  const handoffRecord = {
    kind: 'exact',
    path: `${ROUTE_BASE}/projects/handoff`,
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const raw = typeof body.path === 'string' ? body.path.trim() : ''
        const handoff = typeof body.handoffPath === 'string' ? body.handoffPath.trim() : ''
        if (raw.length === 0 || handoff.length === 0) {
          sendJson(res, 400, { error: 'path and handoffPath are required' })
          return
        }
        const resolved = path.resolve(raw)
        const key = projectKey(resolved)
        const existing = Array.isArray(store.get(key)?.handoffs) ? store.get(key).handoffs : []
        const absolute = path.resolve(handoff)

        let next
        if (body.forget === true) {
          // A document somebody deleted should be droppable from the list, or the
          // entry becomes a dead link the user cannot get rid of.
          next = existing.filter((row) => row.path !== absolute)
        } else if (existing.some((row) => row.path === absolute)) {
          next = existing
        } else {
          next = [
            {
              path: absolute,
              createdAt: now().toISOString(),
              sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
            },
            ...existing,
          ].slice(0, 50)
        }

        store.upsert(key, { path: resolved, handoffs: next })
        sendJson(res, 200, { ok: true, handoffs: next })
      } catch (error) {
        fail(res, 500, error)
      }
    },
  }

  const settings = {
    kind: 'exact',
    path: `${ROUTE_BASE}/settings`,
    handler: async (req, res) => {
      try {
        if ((req.method ?? 'GET').toUpperCase() === 'GET') {
          sendJson(res, 200, {
            settings: normalizeSettings(store.settings()),
            defaults: SETTINGS_DEFAULTS,
            languages: PROMPT_LANGUAGES,
            wayfinderRange: WAYFINDER_RANGE,
          })
          return
        }

        const body = await readJsonBody(req)
        const accepted = {}
        for (const key of ['sessionBar', 'turnTail', 'sessionHover']) {
          if (typeof body[key] === 'boolean') accepted[key] = body[key]
        }
        if (Number.isInteger(body.wayfinderThreshold)) accepted.wayfinderThreshold = body.wayfinderThreshold
        if (typeof body.promptLanguage === 'string') accepted.promptLanguage = body.promptLanguage

        // Normalise the merged result, so a rejected value falls back to its
        // default here rather than being stored and then misreported by the UI.
        const next = normalizeSettings({ ...store.settings(), ...accepted })
        store.saveSettings(next)
        sendJson(res, 200, { settings: next })
      } catch (error) {
        fail(res, 500, error)
      }
    },
  }

  return [health, skills, skillStatus, overview, probe, artifacts, artifact, tickets, stage, prompt, settings, bind, setTracker, setStage, handoffRecord, unbind]
}
