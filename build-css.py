#!/usr/bin/env python3
"""
Builds socialphix.css from the classes actually used in the HTML.

Replaces cdn.tailwindcss.com, which ships a ~400KB JIT compiler that
recompiles your stylesheet in the browser on every single page load.
The Tailwind team say plainly it isn't for production.

Run this again any time you add new classes:
    python3 build-css.py
"""

import re, glob, os

# ---------------------------------------------------------------- tokens

COLORS = {
    "brand-bg": "#050B14", "brand-surface": "#0A192F", "brand-card": "#112240",
    "accent-cyan": "#00E5FF", "accent-orange": "#FF5722", "accent-orange-hover": "#E64A19",
    "white": "#ffffff", "black": "#000000", "transparent": "transparent",
    "slate-200": "#e2e8f0", "slate-300": "#cbd5e1", "slate-400": "#94a3b8", "slate-500": "#64748b",
    "slate-600": "#475569", "slate-700": "#334155", "slate-800": "#1e293b",
}

RGB = {
    "brand-bg": "5,11,20", "brand-surface": "10,25,47", "brand-card": "17,34,64",
    "accent-cyan": "0,229,255", "accent-orange": "255,87,34",
    "slate-700": "51,65,85", "white": "255,255,255",
}

SPACE = {
    "0": "0px", "0.5": "0.125rem", "1": "0.25rem", "1.5": "0.375rem", "2": "0.5rem", "2.5": "0.625rem",
    "3": "0.75rem", "3.5": "0.875rem", "4": "1rem", "5": "1.25rem", "6": "1.5rem",
    "7": "1.75rem", "8": "2rem", "9": "2.25rem", "10": "2.5rem", "11": "2.75rem",
    "12": "3rem", "14": "3.5rem", "16": "4rem", "20": "5rem", "24": "6rem",
    "28": "7rem", "32": "8rem", "36": "9rem", "40": "10rem", "44": "11rem",
    "48": "12rem", "56": "14rem", "64": "16rem", "px": "1px",
}

FONT_SIZE = {
    "xs": ("0.75rem", "1rem"), "sm": ("0.875rem", "1.25rem"), "base": ("1rem", "1.5rem"),
    "lg": ("1.125rem", "1.75rem"), "xl": ("1.25rem", "1.75rem"), "2xl": ("1.5rem", "2rem"),
    "3xl": ("1.875rem", "2.25rem"), "4xl": ("2.25rem", "2.5rem"), "5xl": ("3rem", "1"),
    "6xl": ("3.75rem", "1"), "7xl": ("4.5rem", "1"), "8xl": ("6rem", "1"),
}

RADIUS = {"": "0.25rem", "md": "0.375rem", "lg": "0.5rem", "xl": "0.75rem",
          "2xl": "1rem", "3xl": "1.5rem", "full": "9999px"}

WEIGHT = {"normal": "400", "medium": "500", "semibold": "600", "bold": "700", "extrabold": "800"}

MAXW = {"md": "28rem", "lg": "32rem", "xl": "36rem", "2xl": "42rem", "3xl": "48rem",
        "4xl": "56rem", "5xl": "64rem", "6xl": "72rem", "7xl": "80rem", "sm": "24rem"}

TRACKING = {"tighter": "-0.05em", "tight": "-0.025em", "normal": "0em",
            "wide": "0.025em", "wider": "0.05em", "widest": "0.1em"}

LEADING = {"none": "1", "tight": "1.25", "snug": "1.375", "normal": "1.5",
           "relaxed": "1.625", "loose": "2"}


def color_of(token):
    """Handles `accent-cyan` and `accent-cyan/30` alpha variants."""
    if "/" in token:
        name, alpha = token.rsplit("/", 1)
        if name in RGB:
            return f"rgba({RGB[name]},{int(alpha)/100})"
        if name in COLORS:
            return COLORS[name]
        return None
    return COLORS.get(token)


def arbitrary(cls):
    """Pulls the value out of things like shadow-[0_0_20px_rgba(...)]."""
    m = re.search(r"\[(.+)\]$", cls)
    return m.group(1).replace("_", " ") if m else None


# ---------------------------------------------------------------- rules

def rule(cls):
    """Returns the CSS body for a single utility class, or None."""
    c = cls

    # --- layout ---
    if c == "block": return "display:block"
    if c == "inline-block": return "display:inline-block"
    if c == "inline-flex": return "display:inline-flex"
    if c == "flex": return "display:flex"
    if c == "grid": return "display:grid"
    if c == "hidden": return "display:none"
    if c == "flex-col": return "flex-direction:column"
    if c == "flex-row": return "flex-direction:row"
    if c == "flex-wrap": return "flex-wrap:wrap"
    if c == "flex-1": return "flex:1 1 0%"
    if c == "flex-grow": return "flex-grow:1"
    if c == "flex-shrink-0": return "flex-shrink:0"
    if c == "relative": return "position:relative"
    if c == "absolute": return "position:absolute"
    if c == "fixed": return "position:fixed"
    if c == "inset-0": return "top:0;right:0;bottom:0;left:0"
    if c == "inset-y-0": return "top:0;bottom:0"

    if c.startswith("grid-cols-"):
        n = c.split("-")[-1]
        return f"grid-template-columns:repeat({n},minmax(0,1fr))"
    if c.startswith("col-span-"):
        return f"grid-column:span {c.split('-')[-1]}/span {c.split('-')[-1]}"
    if c.startswith("col-start-"):
        return f"grid-column-start:{c.split('-')[-1]}"

    if c.startswith("items-"): 
        v = c[6:]
        return f"align-items:{{'start':'flex-start','center':'center','end':'flex-end','baseline':'baseline','stretch':'stretch'}}".replace("{{", "").replace("}}", "") and f"align-items:{ {'start':'flex-start','center':'center','end':'flex-end','baseline':'baseline','stretch':'stretch'}.get(v,v) }"
    if c.startswith("justify-"):
        v = c[8:]
        return f"justify-content:{ {'start':'flex-start','center':'center','end':'flex-end','between':'space-between','around':'space-around'}.get(v,v) }"

    # --- spacing ---
    for pre, prop in [("p", "padding"), ("m", "margin")]:
        for suf, sides in [("", None), ("t", ["top"]), ("b", ["bottom"]),
                           ("l", ["left"]), ("r", ["right"]),
                           ("x", ["left", "right"]), ("y", ["top", "bottom"])]:
            key = pre + suf + "-"
            if c.startswith(key):
                val = c[len(key):]
                neg = val.startswith("-")
                v = SPACE.get(val.lstrip("-"))
                if v is None: continue
                if neg: v = "-" + v
                if sides is None: return f"{prop}:{v}"
                return ";".join(f"{prop}-{s}:{v}" for s in sides)

    if c.startswith("gap-"):
        v = SPACE.get(c[4:])
        if v: return f"gap:{v}"
    if c.startswith("space-y-"):
        v = SPACE.get(c[8:])
        if v: return f"--tw-space-y:{v}"
    if c.startswith("space-x-"):
        v = SPACE.get(c[8:])
        if v: return f"--tw-space-x:{v}"

    # --- sizing ---
    if c.startswith("w-") or c.startswith("h-"):
        prop = "width" if c[0] == "w" else "height"
        val = c[2:]
        a = arbitrary(c)
        if a: return f"{prop}:{a}"
        if val == "full": return f"{prop}:100%"
        if val == "auto": return f"{prop}:auto"
        if val == "screen": return f"{prop}:100v{'w' if prop=='width' else 'h'}"
        if "/" in val:
            n, d = val.split("/")
            return f"{prop}:{round(int(n)/int(d)*100, 6)}%"
        v = SPACE.get(val)
        if v: return f"{prop}:{v}"
    if c == "min-h-screen": return "min-height:100vh"
    if c.startswith("max-w-"):
        v = c[6:]
        a = arbitrary(c)
        if a: return f"max-width:{a}"
        if v == "full": return "max-width:100%"
        if v in MAXW: return f"max-width:{MAXW[v]}"
    if c.startswith("aspect-"):
        a = arbitrary(c)
        if a: return f"aspect-ratio:{a.replace('/', ' / ')}"

    # --- typography ---
    if c.startswith("text-"):
        v = c[5:]
        a = arbitrary(c)
        if a: return f"font-size:{a}"
        if v in FONT_SIZE:
            size, lh = FONT_SIZE[v]
            return f"font-size:{size};line-height:{lh}"
        if v in ("left", "center", "right", "justify"): return f"text-align:{v}"
        col = color_of(v)
        if col: return f"color:{col}"
    if c.startswith("font-"):
        v = c[5:]
        if v in WEIGHT: return f"font-weight:{WEIGHT[v]}"
        if v == "heading": return 'font-family:"Plus Jakarta Sans",ui-sans-serif,system-ui,sans-serif'
        if v == "sans": return 'font-family:"Inter",ui-sans-serif,system-ui,sans-serif'
    if c.startswith("leading-"):
        a = arbitrary(c)
        if a: return f"line-height:{a}"
        v = LEADING.get(c[8:])
        if v: return f"line-height:{v}"
    if c.startswith("tracking-"):
        a = arbitrary(c)
        if a: return f"letter-spacing:{a}"
        v = TRACKING.get(c[9:])
        if v: return f"letter-spacing:{v}"
    if c == "uppercase": return "text-transform:uppercase"
    if c == "italic": return "font-style:italic"
    if c == "underline": return "text-decoration-line:underline"
    if c == "antialiased": return "-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale"
    if c == "whitespace-nowrap": return "white-space:nowrap"
    if c.startswith("list-"):
        v = c[5:]
        if v == "inside": return "list-style-position:inside"
        if v in ("disc", "decimal", "none"): return f"list-style-type:{v}"
    if c.startswith("placeholder-"):
        col = color_of(c[12:])
        if col: return f"color:{col}"

    # --- backgrounds & borders ---
    if c.startswith("bg-"):
        col = color_of(c[3:])
        if col: return f"background-color:{col}"
    if c == "border": return "border-width:1px"
    if c == "border-t": return "border-top-width:1px"
    if c == "border-b": return "border-bottom-width:1px"
    if c == "border-l": return "border-left-width:1px"
    if c == "border-r": return "border-right-width:1px"
    if c.startswith("border-"):
        v = c[7:]
        if v.isdigit(): return f"border-width:{v}px"
        if v.startswith("t-") or v.startswith("b-") or v.startswith("l-") or v.startswith("r-"):
            side = {"t": "top", "b": "bottom", "l": "left", "r": "right"}[v[0]]
            rest = v[2:]
            if rest.isdigit(): return f"border-{side}-width:{rest}px"
            col = color_of(rest)
            if col: return f"border-{side}-color:{col}"
        col = color_of(v)
        if col: return f"border-color:{col}"
    if c.startswith("rounded"):
        v = c[8:] if len(c) > 7 else ""
        if v in RADIUS: return f"border-radius:{RADIUS[v]}"

    # --- effects ---
    if c.startswith("shadow-"):
        a = arbitrary(c)
        if a: return f"box-shadow:{a}"
    if c.startswith("blur-"):
        a = arbitrary(c)
        if a: return f"filter:blur({a})"
    if c.startswith("backdrop-blur-"):
        v = {"sm": "4px", "md": "12px", "lg": "16px"}.get(c[14:], "8px")
        return f"backdrop-filter:blur({v});-webkit-backdrop-filter:blur({v})"
    if c.startswith("opacity-"):
        return f"opacity:{int(c[8:])/100}"
    if c == "filter": return "filter:var(--tw-filter,none)"
    if c == "grayscale": return "filter:grayscale(100%)"
    if c == "grayscale-0": return "filter:grayscale(0)"

    # --- transforms & transitions ---
    if c == "transform": return "transform:translate(var(--tw-tx,0),var(--tw-ty,0)) scale(var(--tw-scale,1))"
    if c.startswith("-translate-x-") or c.startswith("translate-x-"):
        val = c.split("translate-x-")[1]; neg = c.startswith("-")
        if "/" in val:
            n, d = val.split("/"); p = f"{round(int(n)/int(d)*100,6)}%"
        else:
            p = SPACE.get(val, val)
        return f"--tw-tx:{'-' if neg else ''}{p};transform:translate(var(--tw-tx,0),var(--tw-ty,0)) scale(var(--tw-scale,1))"
    if c.startswith("-translate-y-") or c.startswith("translate-y-"):
        val = c.split("translate-y-")[1]; neg = c.startswith("-")
        if "/" in val:
            n, d = val.split("/"); p = f"{round(int(n)/int(d)*100,6)}%"
        else:
            p = SPACE.get(val, val)
        return f"--tw-ty:{'-' if neg else ''}{p};transform:translate(var(--tw-tx,0),var(--tw-ty,0)) scale(var(--tw-scale,1))"
    if c.startswith("scale-"):
        return f"--tw-scale:{int(c[6:])/100};transform:translate(var(--tw-tx,0),var(--tw-ty,0)) scale(var(--tw-scale,1))"
    if c in ("transition", "transition-all"):
        return "transition-property:all;transition-timing-function:cubic-bezier(.4,0,.2,1);transition-duration:150ms"
    if c == "transition-colors":
        return "transition-property:color,background-color,border-color,fill,stroke;transition-timing-function:cubic-bezier(.4,0,.2,1);transition-duration:150ms"
    if c == "transition-opacity":
        return "transition-property:opacity;transition-timing-function:cubic-bezier(.4,0,.2,1);transition-duration:150ms"
    if c.startswith("duration-"): return f"transition-duration:{c[9:]}ms"
    if c.startswith("delay-"): return f"transition-delay:{c[6:]}ms"

    # --- misc ---
    if c.startswith("z-"): return f"z-index:{c[2:]}"
    if c.startswith("top-") or c.startswith("-top-"):
        val = c.split("top-")[1]; neg = c.startswith("-")
        if "/" in val:
            n, d = val.split("/"); v = f"{round(int(n)/int(d)*100,6)}%"
        else:
            v = SPACE.get(val, val)
        return f"top:{'-' if neg else ''}{v}"
    if c.startswith("left-"):
        val = c[5:]
        if "/" in val:
            n, d = val.split("/"); return f"left:{round(int(n)/int(d)*100,6)}%"
        v = SPACE.get(val)
        if v: return f"left:{v}"
    if c.startswith("right-"):
        v = SPACE.get(c[6:])
        if v: return f"right:{v}"
    if c.startswith("bottom-"):
        v = SPACE.get(c[7:])
        if v: return f"bottom:{v}"
    if c == "overflow-hidden": return "overflow:hidden"
    if c == "mx-auto": return "margin-left:auto;margin-right:auto"
    if c == "pointer-events-none": return "pointer-events:none"
    if c == "cursor-pointer": return "cursor:pointer"
    if c == "select-all": return "user-select:all"
    if c == "appearance-none": return "appearance:none;-webkit-appearance:none"
    if c == "object-cover": return "object-fit:cover"
    if c == "object-center": return "object-position:center"
    if c == "scroll-smooth": return "scroll-behavior:smooth"
    if c == "animate-pulse": return "animation:tw-pulse 2s cubic-bezier(.4,0,.6,1) infinite"
    if c == "focus:outline-none": return "outline:2px solid transparent;outline-offset:2px"
    if c.startswith("ring-"):
        v = c[5:]
        if v.isdigit(): return f"box-shadow:0 0 0 {v}px var(--tw-ring-color,#00E5FF)"
        col = color_of(v)
        if col: return f"--tw-ring-color:{col}"

    return None


# ---------------------------------------------------------------- build

def esc(cls):
    """CSS-escape a class name for use in a selector."""
    return re.sub(r'([:./\[\]()%,#])', r'\\\1', cls)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    classes = set()
    for f in glob.glob(os.path.join(here, "*.html")):
        for m in re.findall(r'class="([^"]+)"', open(f).read()):
            classes.update(m.split())

    base = [
        "*,::before,::after{box-sizing:border-box;border:0 solid #334155}",
        "html{-webkit-text-size-adjust:100%;line-height:1.5;font-family:'Inter',ui-sans-serif,system-ui,sans-serif}",
        "body{margin:0;line-height:inherit}",
        "h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit;margin:0}",
        "p,figure{margin:0}",
        "ul,ol{list-style:none;margin:0;padding:0}",
        "a{color:inherit;text-decoration:inherit}",
        "img,svg,video,canvas{display:block;vertical-align:middle;max-width:100%;height:auto}",
        "button,input,select,textarea{font-family:inherit;font-size:100%;font-weight:inherit;line-height:inherit;color:inherit;margin:0;padding:0}",
        "button{background-color:transparent;background-image:none;cursor:pointer}",
        "table{border-collapse:collapse;text-indent:0;border-color:inherit}",
        "strong{font-weight:bolder}",
        "em{font-style:italic}",
        "@keyframes tw-pulse{0%,100%{opacity:1}50%{opacity:.5}}",
        ".space-y-1>:not([hidden])~:not([hidden]){margin-top:0.25rem}",
        ".space-y-3>:not([hidden])~:not([hidden]){margin-top:0.75rem}",
        ".space-y-4>:not([hidden])~:not([hidden]){margin-top:1rem}",
        ".space-y-5>:not([hidden])~:not([hidden]){margin-top:1.25rem}",
        ".space-y-6>:not([hidden])~:not([hidden]){margin-top:1.5rem}",
        ".space-y-10>:not([hidden])~:not([hidden]){margin-top:2.5rem}",
        ".space-y-12>:not([hidden])~:not([hidden]){margin-top:3rem}",
        ".space-x-8>:not([hidden])~:not([hidden]){margin-left:2rem}",
    ]

    plain, hover, focus, group_hover, focusvis = [], [], [], [], []
    bp = {"sm": [], "md": [], "lg": []}
    unresolved = []

    for c in sorted(classes):
        target, cls = plain, c
        prefix = ""

        for p, bucket in (("hover:", hover), ("focus:", focus),
                          ("group-hover:", group_hover), ("focus-visible:", focusvis)):
            if c.startswith(p):
                target, cls, prefix = bucket, c[len(p):], p
                break
        else:
            for b in ("sm:", "md:", "lg:"):
                if c.startswith(b):
                    target, cls, prefix = bp[b[:-1]], c[len(b):], b
                    break

        if c == "focus:outline-none":
            plain.append(f".{esc(c)}:focus{{outline:2px solid transparent;outline-offset:2px}}")
            continue

        body = rule(cls)
        if not body:
            if not any(cls.startswith(x) for x in (
                "milestone", "pack-", "cite", "policy", "reveal", "glass-nav",
                "bg-grid", "hover-lift", "cyan-glow", "fade-in", "progress-fill",
                "share-btn", "founder-avatar", "references-list", "cf-turnstile",
                "active", "group", "delay-")):
                unresolved.append(c)
            continue

        sel = "." + esc(c)
        if prefix == "hover:":            sel += ":hover"
        elif prefix == "focus:":          sel += ":focus"
        elif prefix == "focus-visible:":  sel += ":focus-visible"
        elif prefix == "group-hover:":    sel = ".group:hover " + sel
        target.append(f"{sel}{{{body}}}")

    out = ["/* Social Phix — generated by build-css.py. Do not edit by hand. */"]
    out += base + plain + hover + focus + focusvis + group_hover
    for b, mw in (("sm", "640px"), ("md", "768px"), ("lg", "1024px")):
        if bp[b]:
            out.append(f"@media (min-width:{mw}){{{''.join(bp[b])}}}")

    css = "\n".join(out)
    path = os.path.join(here, "socialphix.css")
    open(path, "w").write(css)

    print(f"Classes found:   {len(classes)}")
    print(f"Rules generated: {len(plain)+len(hover)+len(focus)+len(focusvis)+len(group_hover)+sum(len(v) for v in bp.values())}")
    print(f"Written:         socialphix.css ({len(css)/1024:.1f} KB)")
    if unresolved:
        print(f"\nNot generated ({len(unresolved)}) — check these render correctly:")
        for u in unresolved:
            print("   ", u)


if __name__ == "__main__":
    main()
