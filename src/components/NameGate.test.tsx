import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { NameGate } from './NameGate'

describe('NameGate', () => {
  it('will not let someone continue without a name', async () => {
    const onSubmit = vi.fn()
    render(<NameGate initial="" onSubmit={onSubmit} />)

    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled()
    await userEvent.click(screen.getByLabelText(/your name/i))
    await userEvent.tab()
    expect(screen.getByRole('alert')).toHaveTextContent(/enter a name/i)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits a trimmed name', async () => {
    const onSubmit = vi.fn()
    render(<NameGate initial="" onSubmit={onSubmit} />)

    await userEvent.type(screen.getByLabelText(/your name/i), '  Sam  ')
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))
    expect(onSubmit).toHaveBeenCalledWith('Sam')
  })

  it('names the room when arriving from an invite', () => {
    render(<NameGate initial="" roomCode="sunny-otter-42" onSubmit={vi.fn()} />)
    expect(screen.getByText('sunny-otter-42')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /join room/i })).toBeInTheDocument()
  })

  it('pre-fills a remembered name', () => {
    render(<NameGate initial="Ada" onSubmit={vi.fn()} />)
    expect(screen.getByLabelText(/your name/i)).toHaveValue('Ada')
  })
})
