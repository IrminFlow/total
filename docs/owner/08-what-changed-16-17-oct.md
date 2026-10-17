# Total: what changed on 16 and 17 October

**17 October 2026.** Written for the owner. It follows 04, the plan. Numbers in brackets like
(#127) are pull requests. A "pull request" (PR) is one proposed change that is reviewed and then
merged into the main copy of the code. Nothing here has been published. No version number was
raised, no tag, no release, no website change.

Thirty-one PRs were merged after the plan was written (#117 to #147). Two of them only changed
documents (#117, #147). The test DMG on your Desktop, `Total-dev-6f90647f.dmg`, holds everything up
to #145. One later change, #146 (the cheque register), is **not** in that DMG. Three more PRs
(#148, #149, #150) are still open and not merged.

---

## What you will notice while testing

### Simple screens

- Small fixes across Home, Taxes and the lists. The GST tile updates after you say "I've filed". Print errors are clear. You can switch between prices with GST and without. The dark theme chip reads better. Someone who can only look is told so at the top of each form and sees a note instead of "Back up now" (#119).
- Names no longer get cut off at a narrow window. Pop-up messages stay clear of the Save bar. Switching company asks first. Opening products use today's GST rates (#130).
- Going to the full editor and back is smoother. Your typed answers are kept, there is no pointless "discard?" question, and the "Always open the full app" menus work (#122).
- Hindi leftovers are fixed: dates in error messages, state names in the setup wizard, the PDF footer, and the language of bank suggestions (#123). The language packs now load only when needed (#143, #145).

### Money and bank

- On the Bank screen you can skip a line, say "Not this", and go back to Bank. A return keeps a note of its bill and shows older bills. The money list shows entries that are ahead (#121).
- Refunds are handled in both directions. Money in from a supplier who owes you nothing back is no longer saved as a refund: Total says so and offers "Record it as other money in". Money out can pay a customer back the money of theirs you hold. Money out shows buying-goods hints (a "Record a purchase instead" row). A bank line can carry a GST bill (#139).

### Stock and recipes

- A product page lets you set when it is "running low". Rows in its history open the entry they came from. A saved stock count can be reopened and shows the difference it made. Undo of a count never leaves stock below zero (#124).
- A product page has a **Recipe** part. You can add or change what goes into one unit, and the labour for it. A changed recipe applies from today; older goods keep the old one (#141).

### People and reminders

- Someone who can only look can now save a customer's statement too. A reminder sent inside your "don't remind within N days" window asks first. Cash flow lines can be clicked to see the entries they are made of (#140).
- Ask Total understands bills by number and TDS or payroll amounts, and its drafts no longer pile up (#125).
- Cheque register: entries saved before you set up a cheque book can be filled in later (#146, not in the test DMG).

### Taxes and reports

- Quarterly filers get the right GSTR links and files, and the Outstandings table has the right width (#134).
- Credit hold is stricter. Restoring a deleted sale to a customer on hold is refused unless the owner overrides with a reason. The customer form has a hold switch. Interest for late TDS deduction is shown, and post-dated cheques can be included in the cash forecast (#126).

### Speed

- Opening Home needs one trip to the data instead of four. The backup check now waits until Home has loaded (#131). On the test laptop under load, launch to Home went from about 22 seconds to about 12 on a very large test business.
- Screens load the first time you open them. The startup load fell from 5.7 MB to 2.7 MB (#135). The backup restore check no longer freezes the app, and a business with more than one year of entries no longer gets a false red "entries do not balance" card on Home (#136).

### Safety and locks

- A viewer or a limited user is now fully held back from profit figures, exports and AI settings, in the reports, the AI helper and Ask Total (#127).
- A business with no people can still lock the screen. With a passphrase it asks for it again; without one, anyone can unlock, and the screen says so (#127).
- **Remember on this computer** is a new tick box at the passphrase prompt. It is off until you tick it, owner only, and it can be forgotten in Settings (#142).
- Small safety fixes: the bin's audit entry is now all-or-nothing, and the open-time check has a time limit (#118). More export gates were closed (#144).

### Accountant screens

- E-invoice uses the original bill per party. ITC reversal leaves an audit row. "Why?" links and pack folder names are fixed (#120).
- Exports ask where to save. E-invoice dates, master lists and anomaly references are corrected (#137).

### Windows and files

- **Settings can move the data folder** (for example out of OneDrive). Total checks the new folder, copies and compares everything, and restarts (#133). The command line tool and the MCP link follow the moved folder (#138) and can open a business locked with a passphrase (#132).
- A Windows-only test failure was fixed (#129). The tour card no longer hides what it points at, and Home's "entries added for a closed date" counts only real cases. The automatic screen tests now work on any date (#128).

---

## What this means for your test week

The 34 simple checks and the 13 accountant checks in 04 section 2 still apply. The numbers did not change. Look twice at these eight, because their screens changed most:

1. **Check 16, Bank statement.** Skip, "Not this" and the back link are new.
2. **Check 17, Return a sale.** The return notes and older bills changed.
3. **Check 18, Count your stock.** Counts can be reopened and undone safely now.
4. **Check 21, Reminder.** It now asks you to confirm and follows your chosen language.
5. **Check 26, Taxes.** Quarterly filers can prepare their files here, and the GSTR links open the quarter's last month.
6. **Check 27, Ask Total.** It reads bills by number and amounts for TDS or payroll.
7. **Check 32, Passphrase lock.** Try "Remember on this computer", then Forget it.
8. **Check 33, Accountant view and back.** Your typed answers should now survive both ways.

Two extras are worth a look if you have time: a product's **Recipe** part (#141), and **Settings, Where Total keeps your books** (#133). Do not move your real data folder while testing. Use a test business.

---

## Still not done

These are in `to-do.md`. Only you or someone outside can do them.

- **Real beginner study.** Until you recruit five or more first-time users, the six scripted test users stand in (decision D5).
- **Native Hindi review.** The Hindi and Hinglish text is machine-drafted and waits for a native speaker (D6).
- **A real Windows PC.** The automatic tests run on Windows, but screens, printing, OneDrive and installer checks need a real machine.
- **A CA review** of the tax points marked UNVERIFIED, plus the figure changes listed in `to-do.md` section 2.
- **Signing.** No Apple Developer ID and no Windows certificate yet, so both builds trigger a warning on first open.
- **NIC portal and live AI.** No portal login and no AI key have been used yet, so those paths are only tested with fakes.
