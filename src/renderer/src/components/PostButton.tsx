import { forwardRef } from 'react'
import { Button, type ButtonProps } from './kit/Button'
import { CAPABILITY_REFUSED_TEXT, useCapabilityRefused } from '../lib/capabilities'

/** WP 7.2: an editor's Save — disabled, with the plain reason as its tooltip, when the owner
 *  turned "can record entries" (canPost) off for this sign-in. Otherwise exactly a Button. */
export const PostButton = forwardRef<HTMLButtonElement, ButtonProps>(function PostButton({ disabled, disabledTitle, ...props }, ref) {
  const refused = useCapabilityRefused('canPost')
  return <Button ref={ref} {...props} disabled={disabled || refused} disabledTitle={refused ? CAPABILITY_REFUSED_TEXT.canPost : disabledTitle} data-post-refused={refused || undefined} />
})
