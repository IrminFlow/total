// Gate polish: the "Unsaved changes" question speaks the reader's language inside the simple shell
// and stays the literal English of the full app (its snapshots) outside it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from '@testing-library/react'
import { LANGUAGE_KEY } from '../lib/i18n'
import { unsavedQuestion, useSession } from '../state/stores'

beforeEach(() => {
  localStorage.clear()
  act(() => useSession.setState({ slug: null, user: null }))
})
afterEach(() => {
  delete document.documentElement.dataset.shell
})

describe('unsaved-changes question', () => {
  it('full app: literal English whatever the language', () => {
    localStorage.setItem(LANGUAGE_KEY, 'hi')
    expect(unsavedQuestion()).toEqual({
      title: 'Unsaved changes',
      message: 'Leave this screen and discard your unsaved changes?',
      confirmLabel: 'Discard changes',
      cancelLabel: 'Stay'
    })
  })

  it('simple shell: Hindi and Hinglish', () => {
    document.documentElement.dataset.shell = 'simple'
    localStorage.setItem(LANGUAGE_KEY, 'hi')
    expect(unsavedQuestion()).toMatchObject({ title: 'बदलाव सेव नहीं हुए', confirmLabel: 'बदलाव छोड़ दें', cancelLabel: 'यहीं रहें' })
    localStorage.setItem(LANGUAGE_KEY, 'hinglish')
    expect(unsavedQuestion()).toMatchObject({ title: 'Badlav save nahi hue', cancelLabel: 'Yahin rahein' })
  })

  it('simple shell in English reads like the full app', () => {
    document.documentElement.dataset.shell = 'simple'
    expect(unsavedQuestion().confirmLabel).toBe('Discard changes')
  })
})
