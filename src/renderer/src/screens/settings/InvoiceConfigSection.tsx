import { TemplateDesigner } from './invoice/TemplateDesigner'

/**
 * Settings → Invoice templates. Since WP 1.10c the old single-form invoice print config is the
 * Classic print template; the designer edits every template (see ./invoice/). The legacy
 * `config:invoice:*` channels still read/write the Classic template for older callers.
 */
export function InvoiceConfigSection(): React.JSX.Element {
  return <TemplateDesigner />
}
