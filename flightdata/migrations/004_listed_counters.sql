-- Codeshare listings whose operator row could not be linked (every observation role 'marketing') are not physical
-- movements of their own. When rolled up they are counted under separate 'listed:*' fields, so the physical counters
-- ('flight-days', 'terminal', 'gate', 'cancelled') never count a codeshare twice, while the listing itself is kept.
ALTER TABLE fd_derived_counts DROP CONSTRAINT fd_derived_counts_field_check;
ALTER TABLE fd_derived_counts ADD CONSTRAINT fd_derived_counts_field_check CHECK (field IN (
  'terminal', 'gate', 'flight-days', 'cancelled', 'code',
  'listed:flight-days', 'listed:terminal', 'listed:gate', 'listed:cancelled', 'listed:code'));
