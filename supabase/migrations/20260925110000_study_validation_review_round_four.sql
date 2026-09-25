-- Study validation and correction, after the fourth review.
--
-- 20260925050000 to 20260925100000 are pushed, so they are superseded here (law 6).
--
-- 1. A LOOK-ALIKE HOST IS A LINK. 20260925100000 compared links as written rather than
--    through the look-alike fold, but the `//host` and bare-domain patterns still took
--    only ASCII host labels -- so `раураl.com` in Cyrillic, which the fold had turned
--    into a link, was now no link at all, and passed whatever the sources cited. Host
--    labels now take a letter or digit of any script, classified under the ICU root
--    collation whatever collation the text carries, so a look-alike host is extracted as
--    written and is unsourced unless a source has that very link. (The generated word
--    class does the same job, but repeated in the pattern it took seconds over a source
--    at the size limit; `[[:alnum:]]` under ICU takes as long as the ASCII class did.)
--
-- 2. AN INVISIBLE CHARACTER BETWEEN WORDS IS A SPACE. The instruction check strips
--    invisible characters, which joins a word split by one -- "ign⟨CGJ⟩ore" -- but also
--    joins two words separated only by one, so "ignore⟨U+3164⟩previous⟨U+3164⟩
--    instructions" no longer had the spaces the pattern needs. The check now reads the
--    text both ways: invisible characters removed, and read as spaces.

-- ------------------------------------------------------------------ 1. links

/* As 20260925100000, with host labels of any script. */
create or replace function public.study_links(p_text text)
returns setof text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select distinct regexp_replace(m[1], '[.,;:!?]+$', '')
  from regexp_matches(
         public.study_link_text(p_text) collate "und-x-icu",
         '((?:h[tx]{2}ps?|ftp|mailto|javascript|vbscript)\s*:\s*[/\\]*[^\s<>"''()\[\]]+'
         '|data:[a-z]+/[a-z0-9.+-]+[;,][^\s<>"''()\[\]]*'
         '|(?:^|(?<=[\s(<\["'']))//[[:alnum:]-]+(?:\.[[:alnum:]-]+)+[^\s<>"''()\[\]]*'
         '|\mwww\.[^\s<>"''()\[\]]+'
         '|(?<![0-9.])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::[0-9]+)?/[^\s<>"''()\[\]]*'
         '|(?<![[:alnum:]_-])[[:alnum:]-]+(?:\.[[:alnum:]-]+)*\.(?:com|net|org|io|co|app|dev'
         '|xyz|info|biz|ru|cn|tk|top|site|online|link|click|me|ly|gg|us|uk|de|fr|ai|example'
         '|shop|zip|mov|live|club|icu|buzz|cam|rest|work|fun|xn--[a-z0-9-]+)\M'
         '(?:/[^\s<>"''()\[\]]*)?)',
         'g') as m
$fn$;

-- ------------------------------------------------------------------ 2. instructions

/* `study_heuristic_text`, with every invisible character read as a space rather than removed. */
create function public.study_heuristic_spaced(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select translate(
           replace(
             regexp_replace(public.study_lower(p_text), public.study_ignorable_class(), ' ', 'g'),
             '。', '.'),
           'аеорсухіјѕԁԛԝһӏαειкνορτυχ',
           'aeopcyxijsdqwhlaeikvoptux')
$fn$;

revoke all on function public.study_heuristic_spaced(text) from public, anon, authenticated;

/* As 20260925100000, over the text read both ways. */
create or replace function public.study_instruction_like(p_text text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select exists (
    select 1
    from (values (public.study_heuristic_text(p_text)),
                 (public.study_heuristic_spaced(p_text))) as read_as (t)
    where read_as.t ~ (
      '(ignore|disregard)\s+(\S+\s+){0,3}(previous|prior|above|earlier|preceding)\s+'
      '(\S+\s+){0,2}(instructions?|prompts?)\M'
      '|\mforget\s+(everything|all)\s+(\S+\s+){0,2}(above|before|previous|prior)\M'
      '|\mnew\s+instructions\s*:'
      '|#{2,}\s*(instruction|system|response)\M'
      '|(^|\n)\s*(system|assistant)\s*:'
      '|\msystem\s+prompt\M|\mdeveloper\s+mode\M'
      '|\m(you are|act as|pretend to be|roleplay as)\s+(now\s+)?(an?\s+)?'
      '(ai|chatbot|language model|llm|ai assistant)\M'
      '|\mas an ai (language )?model\M|\mas a (large )?language model\M'
      '|<\|\s*(im_start|im_end|system|endoftext)\s*\|>|\[/?inst\]|<</?sys>>'))
$fn$;
