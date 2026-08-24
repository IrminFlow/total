/** Highlights the first occurrence of a command's mnemonic without changing the accessible label. */
export function MnemonicText({ label, mnemonic }: { label: string; mnemonic: string }): React.JSX.Element {
  const index = label.toLocaleLowerCase().indexOf(mnemonic.toLocaleLowerCase())
  if (index < 0) return <>{label}</>
  return (
    <>
      {label.slice(0, index)}
      <span className="font-semibold text-shortcut" aria-hidden="true">{label[index]}</span>
      <span className="sr-only">{label[index]}</span>
      {label.slice(index + 1)}
    </>
  )
}
