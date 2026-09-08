-- -----------------------------------------------------------------------------
-- Package 10a: An idea can support another.
--
-- Adds the 'supports' relation kind to relation_kind enum.
-- The newly added enum value is not referenced in this file.
-- -----------------------------------------------------------------------------

alter type public.relation_kind add value if not exists 'supports';
