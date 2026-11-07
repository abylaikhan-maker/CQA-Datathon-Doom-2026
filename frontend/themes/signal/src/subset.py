from fontTools.ttLib import TTFont
from fontTools import subset
import sys
U = "U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0400-04FF,U+0500-052F,U+2000-206F,U+20AC,U+20B8,U+20BD,U+2116,U+2122,U+2190-2199,U+2212,U+2713,U+2715"
def run(src, dst, fam, ps):
    f = TTFont(src)
    cm = f.getBestCmap(); print(src, {d: f['hmtx'][cm[ord(d)]][0] for d in "0123456789"})
    opts = subset.Options(); opts.flavor = "woff2"; opts.layout_features = ["kern","liga","locl","ccmp","lnum","zero","case","ss01","ss02","mark","mkmk","calt","tnum"]
    opts.name_IDs = ["*"]; opts.name_languages = ["*"]; opts.notdef_outline = True; opts.drop_tables += ["DSIG"]
    s = subset.Subsetter(opts); s.populate(unicodes=subset.parse_unicodes(U)); s.subset(f)
    # OFL Reserved Font Name "Plex": a subset is a modified version, so it ships under another name.
    name = f['name']
    for rec in name.names:
        if rec.nameID in (1, 3, 4, 6, 16, 21, 25) or rec.nameID > 255:
            t = rec.toUnicode()
            t = t.replace("IBM Plex Sans", fam).replace("IBM Plex Mono", fam).replace("IBMPlexSans", ps).replace("IBMPlexMono", ps)
            rec.string = t
    for rec in name.names:
        if "Plex" in rec.toUnicode() and rec.nameID not in (0, 7, 13, 14):
            print("  still has Plex:", rec.nameID, rec.toUnicode())
    name.setName("Subset of IBM Plex (SIL OFL 1.1) for the CQA 'signal' theme: Latin + Cyrillic incl. Kazakh. Renamed per the OFL Reserved Font Name clause.", 10, 3, 1, 0x409)
    f.save(dst)
import os
o = sys.argv[1]
run("fonts-src/IBMPlexSans-VF.ttf", f"{o}/SignalSans-VF.woff2", "Signal Sans", "SignalSans")
run("fonts-src/IBMPlexMono-Regular.ttf", f"{o}/SignalMono-Regular.woff2", "Signal Mono", "SignalMono")
run("fonts-src/IBMPlexMono-SemiBold.ttf", f"{o}/SignalMono-SemiBold.woff2", "Signal Mono", "SignalMono")
