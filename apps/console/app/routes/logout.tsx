import { redirect } from 'react-router'
import { clearTokenCookie } from '../lib/session.server'

export async function action() {
  return redirect('/login', { headers: { 'Set-Cookie': clearTokenCookie() } })
}

export async function loader() {
  return redirect('/')
}
