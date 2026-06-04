import { redirect } from 'react-router'
import { clearTokenCookie } from '../lib/session.server'
import type { Route } from './+types/logout'

export async function action({ request }: Route.ActionArgs) {
  return redirect('/login', { headers: { 'Set-Cookie': clearTokenCookie(request) } })
}

export async function loader() {
  return redirect('/')
}
