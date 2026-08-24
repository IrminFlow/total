/**
 * A fingerprint of every migration, in order. GENERATED — see migrations.dbtest.ts.
 *
 * Migrations here are applied by ARRAY POSITION: migrate.ts records MAX(id) and resumes from that
 * index. Nothing keys on a name or a checksum at runtime. Two consequences, both silent:
 *
 *   - EDITING an applied migration changes what a fresh database gets and leaves every existing
 *     one behind, with no error anywhere.
 *   - INSERTING one in the middle shifts every later migration up a position. A database that had
 *     applied N resumes at N, runs what used to be N+1, skips the new one entirely, and then
 *     fails on a CREATE TABLE for something it already has.
 *
 * Neither is visible to a test that builds from scratch, which is every other test in this repo.
 * So the order is pinned here.
 */
export const MIGRATION_HASHES: readonly string[] = [
  '78dfdf626838522f', // 1: CREATE TABLE meta (
  '8255e25119fe4985', // 2: ALTER TABLE voucher_lines ADD COLUMN bank_date TEXT;
  'cdf4f11e89aaefd1', // 3: CREATE TABLE currencies (
  '3dd87b9de498f88f', // 4: ALTER TABLE vouchers ADD COLUMN deleted_at TEXT;
  '1509a52b751ef0e6', // 5: CREATE TABLE tds_sections (
  'e3f98292a5146a54', // 6: CREATE TABLE cost_centres (
  'dce47e9d1ea0f0d3', // 7: ALTER TABLE voucher_types ADD COLUMN suffix TEXT NOT NULL DEFAUL
  'ea085a11c0522ae9', // 8: CREATE TABLE recurring_templates (
  'ba3223a06976fa7e', // 9: ALTER TABLE recurring_templates ADD COLUMN voucher_type_id INTEG
  '56726bba623330df', // 10: CREATE TABLE bank_rules (
  '45e70e1f4285e7db', // 11: CREATE TABLE budgets (
  '29c29a00cd0a3da0', // 12: CREATE INDEX idx_bill_refs_voucher ON bill_refs(voucher_id);
  'ea6eb906e938b8b6', // 13: ALTER TABLE ledgers ADD COLUMN rcm INTEGER NOT NULL DEFAULT 0;
  '97abd11e35fff572', // 14: ALTER TABLE stock_items ADD COLUMN valuation_method TEXT NOT NUL
  'f79cb638fc4dd227', // 15: CREATE TABLE pay_heads (
  '9077e738767c67c2', // 16: ALTER TABLE bank_rules ADD COLUMN min_amount INTEGER;
  'd51c3aa8be0ce4aa', // 17: ALTER TABLE inventory_lines ADD COLUMN discount_paise INTEGER NO
  '84c6c1d524976e75', // 18: ALTER TABLE ledgers ADD COLUMN phone TEXT;
  'e352f01c3f85f76b', // 19: CREATE TABLE gst_filings (
  '81864e19fa4dcc58', // 20: ALTER TABLE stock_items ADD COLUMN block_negative INTEGER;
  '3968e1ea2b5603d9', // 21: ALTER TABLE employees ADD COLUMN bank_account TEXT;
  '888a2a07a6ffce18', // 22: CREATE TABLE party_notes (
  '5b4f1cd11f54dcc8', // 23: ALTER TABLE ledgers ADD COLUMN interest_rate_bp INTEGER;
  '02c8cbf897c458a8', // 24: CREATE TABLE attendance (
  '09f505e79290c187', // 25: ALTER TABLE employees ADD COLUMN email TEXT;
  'c637430f1d692fd7', // 26: ALTER TABLE stock_items ADD COLUMN code TEXT;
  '47b66a34c044083d', // 27: ALTER TABLE ledgers ADD COLUMN msme_status TEXT;
  '45dda908c72b3ef8', // 28: CREATE TABLE asset_blocks (
  'cd39e52744b79991', // 29: ALTER TABLE ledgers ADD COLUMN related_party INTEGER NOT NULL DE
  'd1868fe7bfdafe06', // 30: ALTER TABLE fixed_assets ADD COLUMN opening_accumulated INTEGER 
  'a3c44b450e6a0817', // 31: CREATE TABLE bank_import_profiles (
  '62d50df48bbe07b7', // 32: CREATE TABLE landed_costs (
  '04788edcd0419a43', // 33: CREATE TABLE report_views (
  '4c4d74ddf82630bb', // 34: CREATE TABLE counter_sessions (
  '7b15af058d942ab6', // 35: CREATE TABLE sales_documents (
  'efd874e835d0e645', // 36: CREATE TABLE loans (
]
