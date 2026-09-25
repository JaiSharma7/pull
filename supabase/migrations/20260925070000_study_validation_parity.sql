-- Study validation and correction, after the TypeScript review of round one.
--
-- 20260925050000 and 20260925060000 are pushed, so they are superseded here (law 6).
--
-- 1. THE FOLD IS A MIRROR AGAIN. 20260925060000 folded Cyrillic and Greek look-alikes
--    into `study_fold`, which every equality check uses -- so ν was v and ρ was p, and a
--    matching question pairing ρ with Spearman and p with p-values was "malformed". The
--    look-alike and invisible-character fold now applies only where reading text MORE
--    strictly is safe: finding a give-away, and the two heuristics. `study_fold` is
--    `answerKey` in study.ts again, exactly, and `scripts/test-study-fold-parity.mjs`
--    holds the two to it over every assigned code point.
--
-- 2. AN ANSWER THAT IS PUNCTUATION. `;` folded to nothing, so a question on C whose
--    answer is `;` was `answer_missing`, and a future grader comparing folded keys would
--    have matched it against any other answer that folds to nothing. Both folds now keep
--    such a string as it is (`answerKey` changes with this).
--
-- 3. WORDS, AS JAVASCRIPT SEES THEM. The edge of a word was `[:alnum:]` plus whole
--    Indic blocks, danda included -- so a Hindi question whose answer ends its sentence
--    was quarantined, and one printing its own answer passed. The word and no-spaces
--    classes are now generated from the Unicode properties study.ts uses
--    (`scripts/study-unicode-classes.mjs`), and a phrase's edges are tested one character
--    at a time against them. Whitespace is JavaScript's set, not POSIX's.
--
-- 4. INVISIBLE MEANS FORMAT CHARACTERS. The hidden class held letters and marks too --
--    Hangul fillers, variation selectors, the combining grapheme joiner -- so an emoji's
--    VS16 was refused in a revision. It is now the format characters only.
--
-- 5. A COURSE WHOSE VALIDATION FAILED IS NOT STUCK. Three failed `study_validate`
--    attempts, or a job that finished under a worker older than that step, left every
--    row a draft for ever. `validate_stranded_study_courses` validates any finished
--    course still holding drafts, and `enable_generation_sweeper` schedules it beside the
--    stranded-job sweep, so the deploy step that already re-runs that call picks it up.

-- ------------------------------------------------------------------ characters

/* JavaScript's `\s`: what `.trim()` and `/\s+/` treat as whitespace. */
create function public.study_space_class()
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select '[\t\n\u000b\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
$fn$;

/* Whether a text is empty or only whitespace, as `str()` in study.ts decides it. */
create function public.study_blank(p_text text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select coalesce(p_text, '') ~ ('^' || public.study_space_class() || '*$')
$fn$;

/* The format characters a reader cannot see: invisible separators, joiners, bidi controls. */
create or replace function public.study_hidden_class()
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select '[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]'
$fn$;

/* \p{L}, \p{N} and \p{M}: what continues a word. Generated; see the file header. */
create function public.study_word_class()
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select
  '[\u0030-\u0039\u0041-\u005a\u0061-\u007a\u00aa\u00b2-\u00b3\u00b5\u00b9-\u00ba\u00bc-'
  '\u00be\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u02c1\u02c6-\u02d1\u02e0-\u02e4\u02ec\u02ee'
  '\u0300-\u0374\u0376-\u0377\u037a-\u037d\u037f\u0386\u0388-\u038a\u038c\u038e-\u03a1'
  '\u03a3-\u03f5\u03f7-\u0481\u0483-\u052f\u0531-\u0556\u0559\u0560-\u0588\u0591-\u05bd'
  '\u05bf\u05c1-\u05c2\u05c4-\u05c5\u05c7\u05d0-\u05ea\u05ef-\u05f2\u0610-\u061a\u0620-'
  '\u0669\u066e-\u06d3\u06d5-\u06dc\u06df-\u06e8\u06ea-\u06fc\u06ff\u0710-\u074a\u074d-'
  '\u07b1\u07c0-\u07f5\u07fa\u07fd\u0800-\u082d\u0840-\u085b\u0860-\u086a\u0870-\u0887'
  '\u0889-\u088f\u0897-\u08e1\u08e3-\u0963\u0966-\u096f\u0971-\u0983\u0985-\u098c\u098f-'
  '\u0990\u0993-\u09a8\u09aa-\u09b0\u09b2\u09b6-\u09b9\u09bc-\u09c4\u09c7-\u09c8\u09cb-'
  '\u09ce\u09d7\u09dc-\u09dd\u09df-\u09e3\u09e6-\u09f1\u09f4-\u09f9\u09fc\u09fe\u0a01-'
  '\u0a03\u0a05-\u0a0a\u0a0f-\u0a10\u0a13-\u0a28\u0a2a-\u0a30\u0a32-\u0a33\u0a35-\u0a36'
  '\u0a38-\u0a39\u0a3c\u0a3e-\u0a42\u0a47-\u0a48\u0a4b-\u0a4d\u0a51\u0a59-\u0a5c\u0a5e'
  '\u0a66-\u0a75\u0a81-\u0a83\u0a85-\u0a8d\u0a8f-\u0a91\u0a93-\u0aa8\u0aaa-\u0ab0\u0ab2-'
  '\u0ab3\u0ab5-\u0ab9\u0abc-\u0ac5\u0ac7-\u0ac9\u0acb-\u0acd\u0ad0\u0ae0-\u0ae3\u0ae6-'
  '\u0aef\u0af9-\u0aff\u0b01-\u0b03\u0b05-\u0b0c\u0b0f-\u0b10\u0b13-\u0b28\u0b2a-\u0b30'
  '\u0b32-\u0b33\u0b35-\u0b39\u0b3c-\u0b44\u0b47-\u0b48\u0b4b-\u0b4d\u0b55-\u0b57\u0b5c-'
  '\u0b5d\u0b5f-\u0b63\u0b66-\u0b6f\u0b71-\u0b77\u0b82-\u0b83\u0b85-\u0b8a\u0b8e-\u0b90'
  '\u0b92-\u0b95\u0b99-\u0b9a\u0b9c\u0b9e-\u0b9f\u0ba3-\u0ba4\u0ba8-\u0baa\u0bae-\u0bb9'
  '\u0bbe-\u0bc2\u0bc6-\u0bc8\u0bca-\u0bcd\u0bd0\u0bd7\u0be6-\u0bf2\u0c00-\u0c0c\u0c0e-'
  '\u0c10\u0c12-\u0c28\u0c2a-\u0c39\u0c3c-\u0c44\u0c46-\u0c48\u0c4a-\u0c4d\u0c55-\u0c56'
  '\u0c58-\u0c5a\u0c5c-\u0c5d\u0c60-\u0c63\u0c66-\u0c6f\u0c78-\u0c7e\u0c80-\u0c83\u0c85-'
  '\u0c8c\u0c8e-\u0c90\u0c92-\u0ca8\u0caa-\u0cb3\u0cb5-\u0cb9\u0cbc-\u0cc4\u0cc6-\u0cc8'
  '\u0cca-\u0ccd\u0cd5-\u0cd6\u0cdc-\u0cde\u0ce0-\u0ce3\u0ce6-\u0cef\u0cf1-\u0cf3\u0d00-'
  '\u0d0c\u0d0e-\u0d10\u0d12-\u0d44\u0d46-\u0d48\u0d4a-\u0d4e\u0d54-\u0d63\u0d66-\u0d78'
  '\u0d7a-\u0d7f\u0d81-\u0d83\u0d85-\u0d96\u0d9a-\u0db1\u0db3-\u0dbb\u0dbd\u0dc0-\u0dc6'
  '\u0dca\u0dcf-\u0dd4\u0dd6\u0dd8-\u0ddf\u0de6-\u0def\u0df2-\u0df3\u0e01-\u0e3a\u0e40-'
  '\u0e4e\u0e50-\u0e59\u0e81-\u0e82\u0e84\u0e86-\u0e8a\u0e8c-\u0ea3\u0ea5\u0ea7-\u0ebd'
  '\u0ec0-\u0ec4\u0ec6\u0ec8-\u0ece\u0ed0-\u0ed9\u0edc-\u0edf\u0f00\u0f18-\u0f19\u0f20-'
  '\u0f33\u0f35\u0f37\u0f39\u0f3e-\u0f47\u0f49-\u0f6c\u0f71-\u0f84\u0f86-\u0f97\u0f99-'
  '\u0fbc\u0fc6\u1000-\u1049\u1050-\u109d\u10a0-\u10c5\u10c7\u10cd\u10d0-\u10fa\u10fc-'
  '\u1248\u124a-\u124d\u1250-\u1256\u1258\u125a-\u125d\u1260-\u1288\u128a-\u128d\u1290-'
  '\u12b0\u12b2-\u12b5\u12b8-\u12be\u12c0\u12c2-\u12c5\u12c8-\u12d6\u12d8-\u1310\u1312-'
  '\u1315\u1318-\u135a\u135d-\u135f\u1369-\u137c\u1380-\u138f\u13a0-\u13f5\u13f8-\u13fd'
  '\u1401-\u166c\u166f-\u167f\u1681-\u169a\u16a0-\u16ea\u16ee-\u16f8\u1700-\u1715\u171f-'
  '\u1734\u1740-\u1753\u1760-\u176c\u176e-\u1770\u1772-\u1773\u1780-\u17d3\u17d7\u17dc-'
  '\u17dd\u17e0-\u17e9\u17f0-\u17f9\u180b-\u180d\u180f-\u1819\u1820-\u1878\u1880-\u18aa'
  '\u18b0-\u18f5\u1900-\u191e\u1920-\u192b\u1930-\u193b\u1946-\u196d\u1970-\u1974\u1980-'
  '\u19ab\u19b0-\u19c9\u19d0-\u19da\u1a00-\u1a1b\u1a20-\u1a5e\u1a60-\u1a7c\u1a7f-\u1a89'
  '\u1a90-\u1a99\u1aa7\u1ab0-\u1add\u1ae0-\u1aeb\u1b00-\u1b4c\u1b50-\u1b59\u1b6b-\u1b73'
  '\u1b80-\u1bf3\u1c00-\u1c37\u1c40-\u1c49\u1c4d-\u1c7d\u1c80-\u1c8a\u1c90-\u1cba\u1cbd-'
  '\u1cbf\u1cd0-\u1cd2\u1cd4-\u1cfa\u1d00-\u1f15\u1f18-\u1f1d\u1f20-\u1f45\u1f48-\u1f4d'
  '\u1f50-\u1f57\u1f59\u1f5b\u1f5d\u1f5f-\u1f7d\u1f80-\u1fb4\u1fb6-\u1fbc\u1fbe\u1fc2-'
  '\u1fc4\u1fc6-\u1fcc\u1fd0-\u1fd3\u1fd6-\u1fdb\u1fe0-\u1fec\u1ff2-\u1ff4\u1ff6-\u1ffc'
  '\u2070-\u2071\u2074-\u2079\u207f-\u2089\u2090-\u209c\u20d0-\u20f0\u2102\u2107\u210a-'
  '\u2113\u2115\u2119-\u211d\u2124\u2126\u2128\u212a-\u212d\u212f-\u2139\u213c-\u213f'
  '\u2145-\u2149\u214e\u2150-\u2189\u2460-\u249b\u24ea-\u24ff\u2776-\u2793\u2c00-\u2ce4'
  '\u2ceb-\u2cf3\u2cfd\u2d00-\u2d25\u2d27\u2d2d\u2d30-\u2d67\u2d6f\u2d7f-\u2d96\u2da0-'
  '\u2da6\u2da8-\u2dae\u2db0-\u2db6\u2db8-\u2dbe\u2dc0-\u2dc6\u2dc8-\u2dce\u2dd0-\u2dd6'
  '\u2dd8-\u2dde\u2de0-\u2dff\u2e2f\u3005-\u3007\u3021-\u302f\u3031-\u3035\u3038-\u303c'
  '\u3041-\u3096\u3099-\u309a\u309d-\u309f\u30a1-\u30fa\u30fc-\u30ff\u3105-\u312f\u3131-'
  '\u318e\u3192-\u3195\u31a0-\u31bf\u31f0-\u31ff\u3220-\u3229\u3248-\u324f\u3251-\u325f'
  '\u3280-\u3289\u32b1-\u32bf\u3400-\u4dbf\u4e00-\ua48c\ua4d0-\ua4fd\ua500-\ua60c\ua610-'
  '\ua62b\ua640-\ua672\ua674-\ua67d\ua67f-\ua6f1\ua717-\ua71f\ua722-\ua788\ua78b-\ua7dc'
  '\ua7f1-\ua827\ua82c\ua830-\ua835\ua840-\ua873\ua880-\ua8c5\ua8d0-\ua8d9\ua8e0-\ua8f7'
  '\ua8fb\ua8fd-\ua92d\ua930-\ua953\ua960-\ua97c\ua980-\ua9c0\ua9cf-\ua9d9\ua9e0-\ua9fe'
  '\uaa00-\uaa36\uaa40-\uaa4d\uaa50-\uaa59\uaa60-\uaa76\uaa7a-\uaac2\uaadb-\uaadd\uaae0-'
  '\uaaef\uaaf2-\uaaf6\uab01-\uab06\uab09-\uab0e\uab11-\uab16\uab20-\uab26\uab28-\uab2e'
  '\uab30-\uab5a\uab5c-\uab69\uab70-\uabea\uabec-\uabed\uabf0-\uabf9\uac00-\ud7a3\ud7b0-'
  '\ud7c6\ud7cb-\ud7fb\uf900-\ufa6d\ufa70-\ufad9\ufb00-\ufb06\ufb13-\ufb17\ufb1d-\ufb28'
  '\ufb2a-\ufb36\ufb38-\ufb3c\ufb3e\ufb40-\ufb41\ufb43-\ufb44\ufb46-\ufbb1\ufbd3-\ufd3d'
  '\ufd50-\ufd8f\ufd92-\ufdc7\ufdf0-\ufdfb\ufe00-\ufe0f\ufe20-\ufe2f\ufe70-\ufe74\ufe76-'
  '\ufefc\uff10-\uff19\uff21-\uff3a\uff41-\uff5a\uff66-\uffbe\uffc2-\uffc7\uffca-\uffcf'
  '\uffd2-\uffd7\uffda-\uffdc\U00010000-\U0001000b\U0001000d-\U00010026\U00010028-'
  '\U0001003a\U0001003c-\U0001003d\U0001003f-\U0001004d\U00010050-\U0001005d\U00010080-'
  '\U000100fa\U00010107-\U00010133\U00010140-\U00010178\U0001018a-\U0001018b\U000101fd'
  '\U00010280-\U0001029c\U000102a0-\U000102d0\U000102e0-\U000102fb\U00010300-\U00010323'
  '\U0001032d-\U0001034a\U00010350-\U0001037a\U00010380-\U0001039d\U000103a0-\U000103c3'
  '\U000103c8-\U000103cf\U000103d1-\U000103d5\U00010400-\U0001049d\U000104a0-\U000104a9'
  '\U000104b0-\U000104d3\U000104d8-\U000104fb\U00010500-\U00010527\U00010530-\U00010563'
  '\U00010570-\U0001057a\U0001057c-\U0001058a\U0001058c-\U00010592\U00010594-\U00010595'
  '\U00010597-\U000105a1\U000105a3-\U000105b1\U000105b3-\U000105b9\U000105bb-\U000105bc'
  '\U000105c0-\U000105f3\U00010600-\U00010736\U00010740-\U00010755\U00010760-\U00010767'
  '\U00010780-\U00010785\U00010787-\U000107b0\U000107b2-\U000107ba\U00010800-\U00010805'
  '\U00010808\U0001080a-\U00010835\U00010837-\U00010838\U0001083c\U0001083f-\U00010855'
  '\U00010858-\U00010876\U00010879-\U0001089e\U000108a7-\U000108af\U000108e0-\U000108f2'
  '\U000108f4-\U000108f5\U000108fb-\U0001091b\U00010920-\U00010939\U00010940-\U00010959'
  '\U00010980-\U000109b7\U000109bc-\U000109cf\U000109d2-\U00010a03\U00010a05-\U00010a06'
  '\U00010a0c-\U00010a13\U00010a15-\U00010a17\U00010a19-\U00010a35\U00010a38-\U00010a3a'
  '\U00010a3f-\U00010a48\U00010a60-\U00010a7e\U00010a80-\U00010a9f\U00010ac0-\U00010ac7'
  '\U00010ac9-\U00010ae6\U00010aeb-\U00010aef\U00010b00-\U00010b35\U00010b40-\U00010b55'
  '\U00010b58-\U00010b72\U00010b78-\U00010b91\U00010ba9-\U00010baf\U00010c00-\U00010c48'
  '\U00010c80-\U00010cb2\U00010cc0-\U00010cf2\U00010cfa-\U00010d27\U00010d30-\U00010d39'
  '\U00010d40-\U00010d65\U00010d69-\U00010d6d\U00010d6f-\U00010d85\U00010e60-\U00010e7e'
  '\U00010e80-\U00010ea9\U00010eab-\U00010eac\U00010eb0-\U00010eb1\U00010ec2-\U00010ec7'
  '\U00010efa-\U00010f27\U00010f30-\U00010f54\U00010f70-\U00010f85\U00010fb0-\U00010fcb'
  '\U00010fe0-\U00010ff6\U00011000-\U00011046\U00011052-\U00011075\U0001107f-\U000110ba'
  '\U000110c2\U000110d0-\U000110e8\U000110f0-\U000110f9\U00011100-\U00011134\U00011136-'
  '\U0001113f\U00011144-\U00011147\U00011150-\U00011173\U00011176\U00011180-\U000111c4'
  '\U000111c9-\U000111cc\U000111ce-\U000111da\U000111dc\U000111e1-\U000111f4\U00011200-'
  '\U00011211\U00011213-\U00011237\U0001123e-\U00011241\U00011280-\U00011286\U00011288'
  '\U0001128a-\U0001128d\U0001128f-\U0001129d\U0001129f-\U000112a8\U000112b0-\U000112ea'
  '\U000112f0-\U000112f9\U00011300-\U00011303\U00011305-\U0001130c\U0001130f-\U00011310'
  '\U00011313-\U00011328\U0001132a-\U00011330\U00011332-\U00011333\U00011335-\U00011339'
  '\U0001133b-\U00011344\U00011347-\U00011348\U0001134b-\U0001134d\U00011350\U00011357'
  '\U0001135d-\U00011363\U00011366-\U0001136c\U00011370-\U00011374\U00011380-\U00011389'
  '\U0001138b\U0001138e\U00011390-\U000113b5\U000113b7-\U000113c0\U000113c2\U000113c5'
  '\U000113c7-\U000113ca\U000113cc-\U000113d3\U000113e1-\U000113e2\U00011400-\U0001144a'
  '\U00011450-\U00011459\U0001145e-\U00011461\U00011480-\U000114c5\U000114c7\U000114d0-'
  '\U000114d9\U00011580-\U000115b5\U000115b8-\U000115c0\U000115d8-\U000115dd\U00011600-'
  '\U00011640\U00011644\U00011650-\U00011659\U00011680-\U000116b8\U000116c0-\U000116c9'
  '\U000116d0-\U000116e3\U00011700-\U0001171a\U0001171d-\U0001172b\U00011730-\U0001173b'
  '\U00011740-\U00011746\U00011800-\U0001183a\U000118a0-\U000118f2\U000118ff-\U00011906'
  '\U00011909\U0001190c-\U00011913\U00011915-\U00011916\U00011918-\U00011935\U00011937-'
  '\U00011938\U0001193b-\U00011943\U00011950-\U00011959\U000119a0-\U000119a7\U000119aa-'
  '\U000119d7\U000119da-\U000119e1\U000119e3-\U000119e4\U00011a00-\U00011a3e\U00011a47'
  '\U00011a50-\U00011a99\U00011a9d\U00011ab0-\U00011af8\U00011b60-\U00011b67\U00011bc0-'
  '\U00011be0\U00011bf0-\U00011bf9\U00011c00-\U00011c08\U00011c0a-\U00011c36\U00011c38-'
  '\U00011c40\U00011c50-\U00011c6c\U00011c72-\U00011c8f\U00011c92-\U00011ca7\U00011ca9-'
  '\U00011cb6\U00011d00-\U00011d06\U00011d08-\U00011d09\U00011d0b-\U00011d36\U00011d3a'
  '\U00011d3c-\U00011d3d\U00011d3f-\U00011d47\U00011d50-\U00011d59\U00011d60-\U00011d65'
  '\U00011d67-\U00011d68\U00011d6a-\U00011d8e\U00011d90-\U00011d91\U00011d93-\U00011d98'
  '\U00011da0-\U00011da9\U00011db0-\U00011ddb\U00011de0-\U00011de9\U00011ee0-\U00011ef6'
  '\U00011f00-\U00011f10\U00011f12-\U00011f3a\U00011f3e-\U00011f42\U00011f50-\U00011f5a'
  '\U00011fb0\U00011fc0-\U00011fd4\U00012000-\U00012399\U00012400-\U0001246e\U00012480-'
  '\U00012543\U00012f90-\U00012ff0\U00013000-\U0001342f\U00013440-\U00013455\U00013460-'
  '\U000143fa\U00014400-\U00014646\U00016100-\U00016139\U00016800-\U00016a38\U00016a40-'
  '\U00016a5e\U00016a60-\U00016a69\U00016a70-\U00016abe\U00016ac0-\U00016ac9\U00016ad0-'
  '\U00016aed\U00016af0-\U00016af4\U00016b00-\U00016b36\U00016b40-\U00016b43\U00016b50-'
  '\U00016b59\U00016b5b-\U00016b61\U00016b63-\U00016b77\U00016b7d-\U00016b8f\U00016d40-'
  '\U00016d6c\U00016d70-\U00016d79\U00016e40-\U00016e96\U00016ea0-\U00016eb8\U00016ebb-'
  '\U00016ed3\U00016f00-\U00016f4a\U00016f4f-\U00016f87\U00016f8f-\U00016f9f\U00016fe0-'
  '\U00016fe1\U00016fe3-\U00016fe4\U00016ff0-\U00016ff6\U00017000-\U00018cd5\U00018cff-'
  '\U00018d1e\U00018d80-\U00018df2\U0001aff0-\U0001aff3\U0001aff5-\U0001affb\U0001affd-'
  '\U0001affe\U0001b000-\U0001b122\U0001b132\U0001b150-\U0001b152\U0001b155\U0001b164-'
  '\U0001b167\U0001b170-\U0001b2fb\U0001bc00-\U0001bc6a\U0001bc70-\U0001bc7c\U0001bc80-'
  '\U0001bc88\U0001bc90-\U0001bc99\U0001bc9d-\U0001bc9e\U0001ccf0-\U0001ccf9\U0001cf00-'
  '\U0001cf2d\U0001cf30-\U0001cf46\U0001d165-\U0001d169\U0001d16d-\U0001d172\U0001d17b-'
  '\U0001d182\U0001d185-\U0001d18b\U0001d1aa-\U0001d1ad\U0001d242-\U0001d244\U0001d2c0-'
  '\U0001d2d3\U0001d2e0-\U0001d2f3\U0001d360-\U0001d378\U0001d400-\U0001d454\U0001d456-'
  '\U0001d49c\U0001d49e-\U0001d49f\U0001d4a2\U0001d4a5-\U0001d4a6\U0001d4a9-\U0001d4ac'
  '\U0001d4ae-\U0001d4b9\U0001d4bb\U0001d4bd-\U0001d4c3\U0001d4c5-\U0001d505\U0001d507-'
  '\U0001d50a\U0001d50d-\U0001d514\U0001d516-\U0001d51c\U0001d51e-\U0001d539\U0001d53b-'
  '\U0001d53e\U0001d540-\U0001d544\U0001d546\U0001d54a-\U0001d550\U0001d552-\U0001d6a5'
  '\U0001d6a8-\U0001d6c0\U0001d6c2-\U0001d6da\U0001d6dc-\U0001d6fa\U0001d6fc-\U0001d714'
  '\U0001d716-\U0001d734\U0001d736-\U0001d74e\U0001d750-\U0001d76e\U0001d770-\U0001d788'
  '\U0001d78a-\U0001d7a8\U0001d7aa-\U0001d7c2\U0001d7c4-\U0001d7cb\U0001d7ce-\U0001d7ff'
  '\U0001da00-\U0001da36\U0001da3b-\U0001da6c\U0001da75\U0001da84\U0001da9b-\U0001da9f'
  '\U0001daa1-\U0001daaf\U0001df00-\U0001df1e\U0001df25-\U0001df2a\U0001e000-\U0001e006'
  '\U0001e008-\U0001e018\U0001e01b-\U0001e021\U0001e023-\U0001e024\U0001e026-\U0001e02a'
  '\U0001e030-\U0001e06d\U0001e08f\U0001e100-\U0001e12c\U0001e130-\U0001e13d\U0001e140-'
  '\U0001e149\U0001e14e\U0001e290-\U0001e2ae\U0001e2c0-\U0001e2f9\U0001e4d0-\U0001e4f9'
  '\U0001e5d0-\U0001e5fa\U0001e6c0-\U0001e6de\U0001e6e0-\U0001e6f5\U0001e6fe-\U0001e6ff'
  '\U0001e7e0-\U0001e7e6\U0001e7e8-\U0001e7eb\U0001e7ed-\U0001e7ee\U0001e7f0-\U0001e7fe'
  '\U0001e800-\U0001e8c4\U0001e8c7-\U0001e8d6\U0001e900-\U0001e94b\U0001e950-\U0001e959'
  '\U0001ec71-\U0001ecab\U0001ecad-\U0001ecaf\U0001ecb1-\U0001ecb4\U0001ed01-\U0001ed2d'
  '\U0001ed2f-\U0001ed3d\U0001ee00-\U0001ee03\U0001ee05-\U0001ee1f\U0001ee21-\U0001ee22'
  '\U0001ee24\U0001ee27\U0001ee29-\U0001ee32\U0001ee34-\U0001ee37\U0001ee39\U0001ee3b'
  '\U0001ee42\U0001ee47\U0001ee49\U0001ee4b\U0001ee4d-\U0001ee4f\U0001ee51-\U0001ee52'
  '\U0001ee54\U0001ee57\U0001ee59\U0001ee5b\U0001ee5d\U0001ee5f\U0001ee61-\U0001ee62'
  '\U0001ee64\U0001ee67-\U0001ee6a\U0001ee6c-\U0001ee72\U0001ee74-\U0001ee77\U0001ee79-'
  '\U0001ee7c\U0001ee7e\U0001ee80-\U0001ee89\U0001ee8b-\U0001ee9b\U0001eea1-\U0001eea3'
  '\U0001eea5-\U0001eea9\U0001eeab-\U0001eebb\U0001f100-\U0001f10c\U0001fbf0-\U0001fbf9'
  '\U00020000-\U0002a6df\U0002a700-\U0002b81d\U0002b820-\U0002cead\U0002ceb0-\U0002ebe0'
  '\U0002ebf0-\U0002ee5d\U0002f800-\U0002fa1d\U00030000-\U0003134a\U00031350-\U00033479'
  '\U000e0100-\U000e01ef]'
$fn$;

/* The scripts written without spaces (`UNSPACED_SCRIPT`). Generated; see the file header. */
create or replace function public.study_unspaced_class()
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select
  '[\u0e01-\u0e3a\u0e40-\u0e5b\u0e81-\u0e82\u0e84\u0e86-\u0e8a\u0e8c-\u0ea3\u0ea5\u0ea7-'
  '\u0ebd\u0ec0-\u0ec4\u0ec6\u0ec8-\u0ece\u0ed0-\u0ed9\u0edc-\u0edf\u1000-\u109f\u1100-'
  '\u11ff\u1780-\u17dd\u17e0-\u17e9\u17f0-\u17f9\u19e0-\u19ff\u2e80-\u2e99\u2e9b-\u2ef3'
  '\u2f00-\u2fd5\u3005\u3007\u3021-\u3029\u302e-\u302f\u3038-\u303b\u3041-\u3096\u309d-'
  '\u309f\u30a1-\u30fa\u30fd-\u30ff\u3131-\u318e\u31f0-\u321e\u3260-\u327e\u32d0-\u32fe'
  '\u3300-\u3357\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97c\ua9e0-\ua9fe\uaa60-\uaa7f\uac00-'
  '\ud7a3\ud7b0-\ud7c6\ud7cb-\ud7fb\uf900-\ufa6d\ufa70-\ufad9\uff66-\uff6f\uff71-\uff9d'
  '\uffa0-\uffbe\uffc2-\uffc7\uffca-\uffcf\uffd2-\uffd7\uffda-\uffdc\U000116d0-\U000116e3'
  '\U00016fe2-\U00016fe3\U00016ff0-\U00016ff6\U0001aff0-\U0001aff3\U0001aff5-\U0001affb'
  '\U0001affd-\U0001affe\U0001b000-\U0001b122\U0001b132\U0001b150-\U0001b152\U0001b155'
  '\U0001b164-\U0001b167\U0001f200\U00020000-\U0002a6df\U0002a700-\U0002b81d\U0002b820-'
  '\U0002cead\U0002ceb0-\U0002ebe0\U0002ebf0-\U0002ee5d\U0002f800-\U0002fa1d\U00030000-'
  '\U0003134a\U00031350-\U00033479]'
$fn$;

/* Whether one character continues a word in a spaced script -- `continuesWord`. */
create function public.study_continues_word(p_char text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select coalesce(p_char, '') <> ''
     and p_char ~ public.study_word_class()
     and p_char !~ public.study_unspaced_class()
$fn$;

/*
 * `answerKey` in study.ts, exactly: NFKC, lower case, an apostrophe separates, the same
 * punctuation removed, whitespace collapsed -- and a string that is only punctuation kept
 * as it is. Every equality and distinctness check uses this.
 */
create or replace function public.study_fold(p_text text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $fn$
declare
  base   text := lower(normalize(coalesce(p_text, ''), nfkc));
  spaces text := public.study_space_class() || '+';
  folded text;
begin
  folded := btrim(regexp_replace(
              regexp_replace(
                regexp_replace(base, '[''‘’`]', ' ', 'g'),
                '[]“”".,;:!?()[{}。、「」『』【】〈〉《》・]', '', 'g'),
              spaces, ' ', 'g'), ' ');
  if folded = '' then
    return btrim(regexp_replace(base, spaces, ' ', 'g'), ' ');
  end if;
  return folded;
end
$fn$;

/*
 * The fold for finding one text inside another, where reading more strictly is safe:
 * `study_fold` after invisible characters are removed and look-alike letters folded, so
 * an answer hidden behind a Cyrillic е or a zero-width space is still found in its prompt.
 */
create function public.study_fold_strict(p_text text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $fn$
begin
  return public.study_fold(public.study_normalized(p_text));
end
$fn$;

/*
 * `containsPhrase` in study.ts, over the strict fold: a phrase in a script written
 * without spaces as a substring; otherwise an occurrence whose edges do not continue a
 * word, tested a character at a time against the generated class.
 */
create or replace function public.study_contains_phrase(p_text text, p_phrase text)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $fn$
declare
  t    text := public.study_fold_strict(p_text);
  p    text := public.study_fold_strict(p_phrase);
  n    integer;
  at   integer;
  done integer := 0;
begin
  if p = '' then
    return false;
  end if;
  if p ~ public.study_unspaced_class() then
    return strpos(t, p) > 0;
  end if;
  n := char_length(p);
  loop
    at := strpos(substr(t, done + 1), p);
    exit when at = 0;
    at := done + at;
    if not public.study_continues_word(case when at > 1 then substr(t, at - 1, 1) end)
       and not public.study_continues_word(substr(t, at + n, 1)) then
      return true;
    end if;
    done := at;
  end loop;
  return false;
end
$fn$;

/* As 20260925050000, folding once rather than three times. */
create or replace function public.study_gives_away(p_answer text)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $fn$
declare
  key text := public.study_fold(p_answer);
begin
  if key ~ public.study_unspaced_class() then
    return char_length(key) >= 2;
  end if;
  return char_length(key) >= 3;
end
$fn$;

-- The checks, with whitespace-only text judged by JavaScript's whitespace.
create or replace function public.study_lesson_problems(
  p_texts text[],
  p_claim_ids uuid[],
  p_links jsonb,
  p_reader boolean default false
)
returns text[]
language sql
stable
set search_path = ''
as $fn$
  select public.study_claims_problems(p_claim_ids)
      || public.study_text_problems(p_texts, p_links)
      || case when p_reader then public.study_hidden_problems(p_texts) else '{}'::text[] end
      || case when exists (select 1 from unnest(array[p_texts[1], p_texts[2], p_texts[3],
                                                      p_texts[5]]) t
                           where public.study_blank(t))
              then array['text_missing'] else '{}'::text[] end
$fn$;

create or replace function public.study_item_problems(
  p_kind text,
  p_prompt text,
  p_answer text,
  p_accepted text[],
  p_distractors jsonb,
  p_cloze text,
  p_sequence text[],
  p_pairs jsonb,
  p_explanation text,
  p_claim_ids uuid[],
  p_lesson_id uuid,
  p_links jsonb,
  p_reader boolean default false
)
returns text[]
language plpgsql
stable
set search_path = ''
as $fn$
declare
  problems  text[] := public.study_claims_problems(p_claim_ids);
  d         jsonb;
  keys      text[] := '{}'::text[];
  k         text;
  a         text;
  correct   text[];
  steps     text[];
  lefts     text[];
  rights    text[];
  evidence  text;
  texts     text[];
  typed     boolean := p_kind in ('cloze', 'short_recall');
begin
  -- Validated or suspended: at generation every lesson is one or quarantined, and a
  -- reader may correct a question while its lesson is itself under a report.
  if p_lesson_id is not null and not exists (
    select 1 from public.study_lessons l
    where l.id = p_lesson_id and l.status in ('validated', 'suspended')
  ) then
    problems := problems || 'lesson_unavailable'::text;
  end if;

  if public.study_fold(p_answer) = '' then
    problems := problems || 'answer_missing'::text;
  end if;
  if public.study_blank(p_prompt) or public.study_blank(p_explanation) then
    problems := problems || 'text_missing'::text;
  end if;
  if exists (select 1 from unnest(coalesce(p_accepted, '{}')) x where public.study_fold(x) = '')
     or (not typed and cardinality(coalesce(p_accepted, '{}')) > 0) then
    problems := problems || 'accepted_answer_invalid'::text;
  end if;

  if p_kind in ('multiple_choice', 'comparison', 'application') then
    if jsonb_typeof(p_distractors) is distinct from 'array'
       or jsonb_array_length(p_distractors) not between 2 and 4 then
      problems := problems || 'too_few_distractors'::text;
    else
      correct := array[public.study_fold(p_answer)]
                 || array(select public.study_fold(x) from unnest(coalesce(p_accepted, '{}')) x);
      for d in select value from jsonb_array_elements(p_distractors) loop
        k := public.study_fold(d ->> 'text');
        if k = '' then
          problems := problems || 'distractor_missing'::text;
        elsif k = any (correct) then
          problems := problems || 'distractor_matches_answer'::text;
        elsif k = any (keys) then
          problems := problems || 'duplicate_options'::text;
        end if;
        keys := keys || k;
        if public.study_fold(d ->> 'why') = '' then
          problems := problems || 'distractor_without_rationale'::text;
        end if;
      end loop;
    end if;
  elsif p_kind = 'cloze' then
    if p_cloze is null
       or (char_length(p_cloze) - char_length(replace(p_cloze, '____', ''))) / 4 <> 1 then
      problems := problems || 'cloze_malformed'::text;
    end if;
  elsif p_kind = 'ordering' then
    steps := array(select public.study_fold(s) from unnest(coalesce(p_sequence, '{}')) s);
    if cardinality(steps) not between 3 and 6
       or '' = any (steps)
       or (select count(distinct s) from unnest(steps) s) <> cardinality(steps) then
      problems := problems || 'ordering_malformed'::text;
    end if;
  elsif p_kind = 'matching' then
    if jsonb_typeof(p_pairs) is distinct from 'array'
       or jsonb_array_length(p_pairs) not between 2 and 6 then
      problems := problems || 'matching_malformed'::text;
    else
      lefts := array(select public.study_fold(value ->> 'left') from jsonb_array_elements(p_pairs));
      rights := array(select public.study_fold(value ->> 'right') from jsonb_array_elements(p_pairs));
      if '' = any (lefts) or '' = any (rights)
         or (select count(distinct x) from unnest(lefts) x) <> cardinality(lefts)
         or (select count(distinct x) from unnest(rights) x) <> cardinality(rights) then
        problems := problems || 'matching_malformed'::text;
      end if;
    end if;
  end if;

  if typed then
    -- A give-away, for the answer and for every accepted variant.
    foreach a in array array[p_answer] || coalesce(p_accepted, '{}') loop
      if public.study_gives_away(a)
         and (public.study_contains_phrase(p_prompt, a)
              or (p_kind = 'cloze' and public.study_contains_phrase(p_cloze, a))) then
        problems := problems || 'answer_in_prompt'::text;
        exit;
      end if;
    end loop;

    -- A cloze's blank, and all of a reader's typed answers, must be in the claims.
    if p_kind = 'cloze' or p_reader then
      select string_agg(concat_ws(' ', c.statement,
                                  (select string_agg(e.span_text, ' ')
                                   from public.study_claim_evidence e where e.claim_id = c.id)),
                        ' ')
        into evidence
      from public.study_claims c
      where c.id = any (coalesce(p_claim_ids, '{}'));
      foreach a in array
        case when p_reader then array[p_answer] || coalesce(p_accepted, '{}')
             else array[p_answer] end
      loop
        if not public.study_contains_phrase(evidence, a) then
          problems := problems || 'answer_not_in_evidence'::text;
          exit;
        end if;
      end loop;
    end if;
  end if;

  texts := array[p_prompt, p_answer, p_cloze, p_explanation]
           || coalesce(p_accepted, '{}') || coalesce(p_sequence, '{}');
  if jsonb_typeof(p_distractors) = 'array' then
    texts := texts || array(select concat_ws(' ', value ->> 'text', value ->> 'why')
                            from jsonb_array_elements(p_distractors));
  end if;
  if jsonb_typeof(p_pairs) = 'array' then
    texts := texts || array(select concat_ws(' ', value ->> 'left', value ->> 'right')
                            from jsonb_array_elements(p_pairs));
  end if;
  return problems
      || public.study_text_problems(texts, p_links)
      || case when p_reader then public.study_hidden_problems(texts) else '{}'::text[] end;
end
$fn$;

revoke all on function
  public.study_space_class(),
  public.study_blank(text),
  public.study_word_class(),
  public.study_continues_word(text),
  public.study_fold_strict(text)
from public, anon, authenticated;

-- ------------------------------------------------------------------ recovery

/*
 * Every finished course still holding drafts, validated: one whose `study_validate` step
 * failed three times, or whose job closed under a worker that predates that step. At
 * most `p_limit` a run, oldest first; a course that cannot be validated now (a source
 * deletion in flight) is skipped and tried again next time.
 */
create function public.validate_stranded_study_courses(
  p_older_than interval default interval '10 minutes',
  p_limit integer default 20
)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  stranded uuid;
  done     integer := 0;
begin
  for stranded in
    select g.job_id
    from public.study_generations g
    join public.generation_jobs j on j.id = g.job_id
    where j.status not in ('queued', 'running')
      and g.created_at < now() - p_older_than
      and (g.text_status = 'pending'
           or exists (select 1 from public.study_claims c
                      where c.generation_id = g.id and c.status = 'draft')
           or exists (select 1 from public.study_lessons l
                      where l.generation_id = g.id and l.status = 'draft')
           or exists (select 1 from public.study_items i
                      where i.generation_id = g.id and i.status = 'draft'))
      and exists (select 1 from public.study_claims c where c.generation_id = g.id)
    order by g.created_at
    limit greatest(coalesce(p_limit, 20), 0)
  loop
    begin
      perform public.validate_study_course(stranded);
      done := done + 1;
    exception when others then
      raise warning 'validate_stranded_study_courses: % could not be validated: %', stranded, sqlerrm;
    end;
  end loop;
  return done;
end
$fn$;

revoke all on function public.validate_stranded_study_courses(interval, integer)
  from public, anon, authenticated;
grant execute on function public.validate_stranded_study_courses(interval, integer) to postgres;

/*
 * As 20260902170000, and the study validation sweep beside it. `cron.schedule` upserts
 * by name, so the deploy step that already re-runs this call picks the new job up.
 */
create or replace function public.enable_generation_sweeper(p_cron text default '*/5 * * * *')
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_id bigint;
begin
  select cron.schedule(
    'sweep-stranded-generation-jobs',
    p_cron,
    'select public.sweep_stranded_generation_jobs();'
  ) into job_id;
  perform cron.schedule(
    'validate-stranded-study-courses',
    p_cron,
    'select public.validate_stranded_study_courses();'
  );
  return job_id;
end;
$$;

revoke all on function public.enable_generation_sweeper(text) from public, anon, authenticated;
