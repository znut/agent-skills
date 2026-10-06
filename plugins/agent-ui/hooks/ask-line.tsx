import type { ClientModule } from 'claude-code'

export type AskLineProps = { key: string; label: string; text: string }

// One ask's toggle line. A press (click, Enter) posts `toggle`; a right-click posts `dismiss`.
// Both name the ask by its text, so a line that moved since this drew is still the one acted on.
const AskLine: ClientModule<AskLineProps> = (props, surface) => {
  const { Button } = surface.elements
  surface.onPointer(event => {
    if (event.type === 'down' && event.button === 'right') surface.post({ act: 'dismiss', text: props.text })
  })
  return <Button key={props.key} plain label={props.label} onPress={() => surface.post({ act: 'toggle', text: props.text })} />
}

export default AskLine
