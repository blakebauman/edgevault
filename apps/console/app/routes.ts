import { index, type RouteConfig, route } from '@react-router/dev/routes'

export default [
  index('routes/home.tsx'),
  route('login', 'routes/login.tsx'),
  route('logout', 'routes/logout.tsx'),
  route('dashboard/:workspaceId', 'routes/dashboard.tsx'),
  route('dashboard/:workspaceId/assistant', 'routes/assistant.tsx'),
  route('orgs/:orgId/scim', 'routes/scim.tsx'),
] satisfies RouteConfig
