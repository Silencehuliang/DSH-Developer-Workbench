const token = process.env.GH_TOKEN
const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'dsh-dev-workbench', 'x-github-api-version': '2022-11-28' }

const query = `query($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, states: [OPEN, CLOSED]) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number title state url body
        labels(first: 20) { nodes { name } }
        blockedBy(first: 50) { totalCount nodes { number state } }
        issueDependenciesSummary { blockedBy totalBlockedBy }
      }
    }
  }
}`

const start = Date.now()
const res = await fetch('https://api.github.com/graphql', {
  method: 'POST',
  headers,
  body: JSON.stringify({ query, variables: { owner: 'Silencehuliang', name: 'DSH-Developer-Workbench', first: 100 } }),
})
const json = await res.json()
console.log('status', res.status, 'ms', Date.now() - start)
if (json.errors) console.log('errors', JSON.stringify(json.errors))
const issues = json?.data?.repository?.issues
console.log('totalCount', issues?.totalCount, 'nodes', issues?.nodes?.length, 'hasNextPage', issues?.pageInfo?.hasNextPage)
for (const node of issues?.nodes ?? []) {
  const blocked = node.blockedBy?.nodes?.map((n) => n.number) ?? []
  console.log(`#${node.number} ${node.state} labels=${node.labels.nodes.map((l) => l.name).join('|')} blockedBy=${JSON.stringify(blocked)} summary=${JSON.stringify(node.issueDependenciesSummary)}`)
}
