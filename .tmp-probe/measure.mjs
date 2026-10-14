import { execFileSync } from 'node:child_process'

const repo = 'Silencehuliang/DSH-Developer-Workbench'
const [owner, name] = repo.split('/')

const token = process.env.GH_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()

async function timed(label, fn) {
  const start = Date.now()
  const value = await fn()
  console.log(`${label}: ${Date.now() - start} ms`, value === undefined ? '' : JSON.stringify(value).slice(0, 160))
}

const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'dsh-dev-workbench', 'x-github-api-version': '2022-11-28' }

// GraphQL: does Issue expose dependency fields at all?
const introspection = await fetch('https://api.github.com/graphql', {
  method: 'POST',
  headers,
  body: JSON.stringify({ query: '{ __type(name: "Issue") { fields { name } } }' }),
}).then((r) => r.json())
const issueFields = introspection?.data?.__type?.fields?.map((f) => f.name) ?? []
console.log('graphql issue field count:', issueFields.length, 'errors:', JSON.stringify(introspection?.errors ?? null))
console.log('dependency-ish fields:', issueFields.filter((n) => /depend|block|relat/i.test(n)))

await timed('rest issue list (state=all, per_page=100)', async () => {
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}/issues?state=all&per_page=100`, { headers })
  const body = await res.json()
  return { status: res.status, count: Array.isArray(body) ? body.length : body }
})

await timed('rest blocked_by #23', async () => {
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}/issues/23/dependencies/blocked_by`, { headers })
  return { status: res.status, body: await res.json() }
})
