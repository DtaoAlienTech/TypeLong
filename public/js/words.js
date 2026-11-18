// Common English words (ASCII, lowercase) used to build weak-key drills without needing the AI.
export const WORDS = (
  "the of and to in is it you that he was for on are with as his they at be this from have or by one had not but what all were when we there can an your which their said if do " +
  "will each about how up out them then she many some so these would other into has more her two like him see time could no make than first been its who now people my made over did down only way find use " +
  "may water long little very after words called just where most know get through back much before go good new write our used me man too any day same right look think also around another came come work three word must because does part " +
  "even place well such here take why help put different away again off went old number great tell men say small every found still between name should home big give air line set own under read last never us left end along while might next sound below saw something thought both few those always looked show large often together asked house don't world going want school important until form food keep children feet land side without boy once animals life enough took sometimes four head above kind began almost live page got earth need far hand high year mother light country father let night picture being study second soon story since white ever paper hard near sentence better best across during today however sure knew try told young sun thing whole hear example heard several change answer room sea against top turned learn point city play toward five using himself usually money seen didn't car morning added friend " +
  "quick quiet quite question quality queen quote quarter square equal request require squeeze jazz jump jacket jelly journey judge juice just justice enjoy project reject major object subject joke join joy " +
  "zebra zero zone zoom size freeze froze lazy crazy dozen puzzle breeze amaze razor citizen blaze prize quiz fizz buzz " +
  "box fix mix six next text exact exit expert extra explore example excellent relax taxi vex complex index mixture expand experience " +
  "kitchen key kind king know knee knock kite keep kept skill skin sky track pack lock walk talk work park market monkey " +
  "very voice value visit view village vote violin victory vision river over seven even give move love above brave have live drive " +
  "year yellow yes yesterday yard yourself young youth they play enjoy happy any every study story city only ready busy copy"
).split(/\s+/).filter((w) => /^[a-z]+$/.test(w));
