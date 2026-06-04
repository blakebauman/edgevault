import { index, type RouteConfig, route } from '@react-router/dev/routes'

export default [
  index('routes/home.tsx'),
  route('login', 'routes/login.tsx'),
  route('logout', 'routes/logout.tsx'),
  route('sso/:orgId/start', 'routes/sso.start.tsx'),
  route('sso/:orgId/callback', 'routes/sso.callback.tsx'),
  route('dashboard/:workspaceId', 'routes/dashboard.tsx'),
  route('dashboard/:workspaceId/assistant', 'routes/assistant.tsx'),
  route('orgs/:orgId/scim', 'routes/scim.tsx'),
  route('orgs/:orgId/sso', 'routes/sso-admin.tsx'),
] satisfies RouteConfig
