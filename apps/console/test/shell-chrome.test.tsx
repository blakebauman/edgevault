import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, Link, Outlet, RouterProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { RouteProgress, useNavDrawer, useRoutePending } from '../app/components/shell-chrome'

/** A miniature of the two shells: burger in the header, rail as the drawer. */
function DrawerHarness() {
  const { open, setOpen, dismiss, sidebarRef, burgerRef } = useNavDrawer()
  return (
    <>
      {open && (
        <button type="button" onClick={dismiss}>
          scrim
        </button>
      )}
      <aside ref={sidebarRef} tabIndex={-1} data-open={open || undefined} aria-label="Rail">
        <Link to="/next">Environments</Link>
      </aside>
      <button ref={burgerRef} type="button" aria-expanded={open} onClick={() => setOpen(true)}>
        Open navigation
      </button>
      <Outlet />
    </>
  )
}

function renderInRouter(element: React.ReactNode) {
  const router = createMemoryRouter([{ path: '/', element }], { initialEntries: ['/'] })
  return render(<RouterProvider router={router} />)
}

describe('useNavDrawer', () => {
  it('opens from the burger and moves focus into the rail', async () => {
    renderInRouter(<DrawerHarness />)
    const burger = screen.getByRole('button', { name: 'Open navigation' })

    await userEvent.click(burger)

    const rail = screen.getByRole('complementary', { name: 'Rail' })
    expect(rail).toHaveAttribute('data-open')
    expect(burger).toHaveAttribute('aria-expanded', 'true')
    // Focus sits on the rail, so the next Tab lands on its first nav link
    // instead of continuing past the drawer.
    expect(rail).toHaveFocus()
  })

  it('closes on Escape and hands focus back to the burger', async () => {
    renderInRouter(<DrawerHarness />)
    const burger = screen.getByRole('button', { name: 'Open navigation' })
    await userEvent.click(burger)

    await userEvent.keyboard('{Escape}')

    expect(screen.getByRole('complementary', { name: 'Rail' })).not.toHaveAttribute('data-open')
    expect(burger).toHaveFocus()
  })

  it('closes on the scrim and hands focus back to the burger', async () => {
    renderInRouter(<DrawerHarness />)
    const burger = screen.getByRole('button', { name: 'Open navigation' })
    await userEvent.click(burger)

    await userEvent.click(screen.getByRole('button', { name: 'scrim' }))

    expect(screen.getByRole('complementary', { name: 'Rail' })).not.toHaveAttribute('data-open')
    expect(burger).toHaveFocus()
  })
})

function PendingHarness() {
  const pending = useRoutePending()
  return (
    <>
      <RouteProgress pending={pending} />
      <Outlet />
    </>
  )
}

/** The progress element carries `data-pending` only while the bar is shown. */
function bar() {
  return document.querySelector('.route-progress')
}

describe('useRoutePending', () => {
  it('stays quiet for a fast navigation and shows once one drags on', async () => {
    vi.useFakeTimers()
    try {
      // A loader that never settles keeps the router in `loading` for as long
      // as the test needs, standing in for a slow API round-trip.
      const router = createMemoryRouter(
        [
          {
            path: '/',
            element: <PendingHarness />,
            children: [{ path: 'slow', loader: () => new Promise(() => {}), element: <p>slow</p> }],
          },
        ],
        { initialEntries: ['/'] },
      )
      render(<RouterProvider router={router} />)

      // Fire the navigation without awaiting it — it never completes by design.
      await act(async () => {
        void router.navigate('/slow')
      })
      // Below the threshold the transition is imperceptible — no bar, no flash.
      await act(async () => {
        vi.advanceTimersByTime(140)
      })
      expect(bar()).not.toHaveAttribute('data-pending')

      await act(async () => {
        vi.advanceTimersByTime(20)
      })
      expect(bar()).toHaveAttribute('data-pending')
    } finally {
      vi.useRealTimers()
    }
  })
})
