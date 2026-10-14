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

import path from 'node:path'

import { readArtifactPreview, scanArtifacts } from './artifacts.js'
import { describeProject, probeDirectory } from './projects.js'
import { readSkillInventory } from './skills.js'
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
export function buildRoutes({ ctx, store, info, now = () => new Date() }) {
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
        const projects = []
        for (const workspace of workspaces) {
          projects.push(await describeProject({ workspace, state: store }))
        }
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
    handler: (req, res) => {
      try {
        const target = queryParam(req, 'path')
        if (target === null) {
          sendJson(res, 400, { error: 'path is required' })
          return
        }
        const resolved = path.resolve(target)
        const mapping = store.get(projectKey(resolved))?.tracker ?? null
        sendJson(res, 200, probeDirectory({ target: resolved, mapping }))
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

  return [health, skills, overview, probe, artifacts, artifact, bind, setTracker, unbind]
}
