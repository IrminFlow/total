import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Coming from Tally — Total Docs'
}

export default function ComingFromTallyPage(): React.JSX.Element {
  return (
    <>
      <h1 className="serif">Coming from Tally</h1>
      <p className="sub">Same keys, same mental model, different app. Here&rsquo;s the map.</p>

      <h2>Keyboard map</h2>
      <p>
        The function-key vocabulary carries over exactly — twenty years of muscle memory still works. A few keys are
        new.
      </p>
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <kbd>F4</kbd>
            </td>
            <td>Contra voucher</td>
          </tr>
          <tr>
            <td>
              <kbd>F5</kbd>
            </td>
            <td>Payment voucher</td>
          </tr>
          <tr>
            <td>
              <kbd>F6</kbd>
            </td>
            <td>Receipt voucher</td>
          </tr>
          <tr>
            <td>
              <kbd>F7</kbd>
            </td>
            <td>Journal voucher</td>
          </tr>
          <tr>
            <td>
              <kbd>F8</kbd>
            </td>
            <td>Sales voucher</td>
          </tr>
          <tr>
            <td>
              <kbd>F9</kbd>
            </td>
            <td>Purchase voucher</td>
          </tr>
          <tr>
            <td>
              <kbd>Ctrl/Alt+F8</kbd>
            </td>
            <td>Credit note</td>
          </tr>
          <tr>
            <td>
              <kbd>Ctrl/Alt+F9</kbd>
            </td>
            <td>Debit note</td>
          </tr>
          <tr>
            <td>
              <kbd>Esc</kbd>
            </td>
            <td>Back out of the current screen</td>
          </tr>
          <tr>
            <td>
              <kbd>↑</kbd> <kbd>↓</kbd> <kbd>↵</kbd>
            </td>
            <td>Move through any list, drill into the selected row</td>
          </tr>
          <tr>
            <td>
              <kbd>⌘K</kbd>
            </td>
            <td>Global search — jump to any ledger, voucher, or command by name (new in Total)</td>
          </tr>
          <tr>
            <td>
              <kbd>⌘↵</kbd>
            </td>
            <td>Save the current voucher</td>
          </tr>
        </tbody>
      </table>

      <h2>Concept map</h2>
      <p>Tally&rsquo;s vocabulary maps onto Total almost one to one:</p>
      <table>
        <thead>
          <tr>
            <th>Tally</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Groups</td>
            <td>Groups — same chart-of-accounts hierarchy</td>
          </tr>
          <tr>
            <td>Ledgers</td>
            <td>Ledgers</td>
          </tr>
          <tr>
            <td>Voucher types</td>
            <td>Voucher types</td>
          </tr>
          <tr>
            <td>Godowns</td>
            <td>Locations</td>
          </tr>
          <tr>
            <td>Cost centres</td>
            <td>Cost centres</td>
          </tr>
          <tr>
            <td>Bill-wise details</td>
            <td>Bill allocations, on the outstandings report</td>
          </tr>
        </tbody>
      </table>

      <h2>Migrating your data</h2>
      <p>Total imports Tally&rsquo;s XML export directly. From Tally:</p>
      <ol>
        <li>
          <b>Masters:</b> Gateway → Display → List of Accounts → Export (XML)
        </li>
        <li>
          <b>Vouchers:</b> Day Book → Export (XML)
        </li>
      </ol>
      <p>Then, in Total:</p>
      <ol>
        <li>Open Company details → Import from Tally</li>
        <li>Pick the exported file</li>
        <li>Review the preview counts (ledgers, groups, stock items, vouchers found)</li>
        <li>Apply the import</li>
        <li>Compare the Trial Balance Total now shows against Tally&rsquo;s — it should match to the paise</li>
      </ol>

      <h2>Known limits</h2>
      <ul>
        <li>Cost centres and bill references in the Tally XML are skipped on import — re-enter these in Total.</li>
        <li>Multi-currency amounts import as INR; re-tag foreign-currency vouchers after import if you need them.</li>
      </ul>
    </>
  )
}
