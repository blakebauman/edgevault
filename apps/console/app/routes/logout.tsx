import { redirect } from 'react-router'
import { clearTokenCookie } from '../lib/session.server'
import type { Route } from './+types/logout'

export async function action({ request }: Route.ActionArgs) {
  // Two cookies to clear (access token + auth session), so build the headers
  // with append — a plain object can only carry one Set-Cookie.
  const headers = new Headers()
  for (const cookie of clearTokenCookie(request)) headers.append('Set-Cookie', cookie)
  return redirect('/login', { headers })
}

export async function loader() {
  return redirect('/')
}
