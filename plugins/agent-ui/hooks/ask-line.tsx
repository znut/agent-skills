import type { ClientModule } from 'claude-code'

export type AskLineProps = { key: string; label: string; text: string }

// One ask's toggle line, drawn as Text, never a Button: the terminal's hit test stops at the
// first pressable (onClick or tabIndex) above the cell and never reaches this Client's pointer
// listener past it, so a Button here swallowed the right-click. Each button press posts once;
// the hooks module decides (left toggles the context, right dismisses), naming the ask by its
// text, so a line that moved since this drew is still the one acted on.
const AskLine: ClientModule<AskLineProps> = (props, surface) => {
  const { Box, Text } = surface.elements
  surface.onPointer(event => {
    if (event.type === 'down') surface.post({ button: event.button ?? null, text: props.text })
  })
  return (
    <Box key={props.key}>
      <Text>{props.label}</Text>
    </Box>
  )
}

export default AskLine
