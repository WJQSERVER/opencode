import {
  createContext,
  createEffect,
  createMemo,
  createSelector,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
  useContext,
} from "solid-js"

import { createResizeObserver } from "@solid-primitives/resize-observer"
import { Icon } from "@opencode/ui/icon"
import { MenuScroll } from "../../components/menu-scroll"
import { TextInput } from "../text-input/text-input"
import { createTypeahead } from "../typeahead/controller"
import { searchListMove, searchListTarget } from "./navigation"
import "./search-list.css"

/** Attributes for a row's element: spread them, then override a handler to change what the pointer does. */
export type SearchListRow = {
  id: string
  role: "option"
  "aria-selected": boolean
  "data-slot": "search-list-row"
  "data-active": "" | undefined
  onMouseMove: (event: MouseEvent) => void
  onMouseDown: (event: MouseEvent) => void
  onClick: () => void
}

/** Attributes for the input of a field passed as `field`: spread them onto it. */
export type SearchListField = {
  role: "combobox"
  "aria-expanded": boolean
  "aria-autocomplete": "list"
  "aria-controls": string | undefined
  "aria-activedescendant": string | undefined
  onInput: (event: InputEvent & { currentTarget: HTMLInputElement }) => void
  onKeyDown: (event: KeyboardEvent) => void
}

export type SearchListHandle<T> = {
  active: () => T | undefined
  /** `pointer` marks a highlight the pointer took through a row handler of the page's own, as the row's own does. */
  setActive: (key: string | undefined, input?: "pointer") => void
}

const QueryContext = createContext<() => string>(() => "")

/** How many extra rows to keep mounted around the viewport, so scrolling does not blank out between renders. */
const OVERSCAN = 8

/**
 * A search field over sectioned results. Rows that share a `section` key list together under one header, which sticks
 * while its rows scroll beneath it until the next header pushes it away. The first row is active until the user picks
 * another: ↑/↓ wrap, ⌘ or ⌥ with ↑/↓ jump between sections, Home/End go to the ends, Enter selects and Escape closes.
 * A page can keep its own field through `field` and float the results beneath it with `popover`.
 */
export function SearchList<T>(props: {
  query: string
  onQuery: (query: string) => void
  placeholder: string
  /** The results' accessible name; the placeholder by default. */
  label?: string
  /** Controls after the field, such as icon buttons. */
  trailing?: JSX.Element
  /** A search field of the page's own in place of the built-in one. */
  field?: (field: SearchListField) => JSX.Element
  /** Whether the results show. Closed, only the field remains and the list leaves keys to the page. On by default. */
  open?: boolean
  /** Float the results beneath the field on a raised surface, over what follows it. */
  popover?: boolean
  items: T[]
  key: (item: T) => string
  section?: (item: T) => string
  /** Rows that show the same thing in two sections. ↑/↓ step past a copy, so the highlight always lands somewhere new. */
  same?: (a: T, b: T) => boolean
  /** A section's header, from its first row. */
  header?: (item: T) => JSX.Element
  /** Shown in place of the rows when there are none. */
  empty: JSX.Element
  /** A note beneath the rows, such as a hint that more results are hidden. */
  footer?: JSX.Element
  /** Whether to draw the top edge fade beneath sticky headers. On by default. */
  topFade?: boolean
  /** Where the results start scrolled each time they mount, such as a position kept from an earlier visit. */
  scrollTop?: number
  onScroll?: (scrollTop: number) => void
  /** Delays `onQuery` by this many ms while the field keeps showing every keystroke. */
  debounceMs?: number
  /** Renders only rows near the viewport. Requires the CSS-fixed 36px rows and 28px section headers. */
  windowed?: boolean
  onSelect: (item: T) => void
  onActive?: (item: T | undefined) => void
  /** Runs before the list's own keys; call `preventDefault` to claim one. */
  onKeyDown?: (event: KeyboardEvent, active: T | undefined) => void
  onClose?: () => void
  ref?: (handle: SearchListHandle<T>) => void
  class?: string
  /** A row. `item` stays current while results with the same key replace it, so the row keeps its element. */
  children: (item: () => T, row: SearchListRow) => JSX.Element
}) {
  let viewport: HTMLDivElement | undefined
  let results: HTMLDivElement | undefined
  let fade: HTMLDivElement | undefined

  const [text, setText] = createSignal(props.query)
  const debounce = () => props.debounceMs ?? 0
  let queryTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(
    on(
      () => props.query,
      (value) => {
        clearTimeout(queryTimer)
        if (value !== text()) setText(value)
      },
    ),
  )
  onCleanup(() => clearTimeout(queryTimer))

  // Windowing measures the real layout once after the first full render: the model dialog uses display:contents
  // sections, 32px rows and much taller headers than the base list, so fixed arithmetic put rows off screen.
  const [metrics, setMetrics] = createSignal<{
    stride: number
    rowHeight: number
    headerHeight: number
    leading: number
    after: number
  } | null>(null)
  const windowed = () => !!props.windowed && metrics() !== null
  const [scrollTop, setScrollTop] = createSignal(0)
  const [viewportHeight, setViewportHeight] = createSignal(0)

  const measureWindow = () => {
    if (!props.windowed || !results) return
    const sections = [...results.querySelectorAll<HTMLElement>('[data-slot="search-list-section"]')]

    for (let index = 0; index < sections.length; index++) {
      const rows = [...sections[index].querySelectorAll<HTMLElement>('[data-slot="search-list-row"]')]

      if (rows.length === 0) continue
      const header = sections[index].querySelector<HTMLElement>('[data-slot="search-list-header"]')
      const first = rows[0].getBoundingClientRect()
      const rowHeight = first.height
      const stride = rows.length > 1 ? rows[1].getBoundingClientRect().top - first.top : rowHeight + 2
      const headerHeight = header?.offsetHeight ?? 0
      const leading = header ? first.top - header.getBoundingClientRect().bottom : 0
      const lastEnd = first.top + (rows.length - 1) * stride + rowHeight
      const next = sections
        .slice(index + 1)
        .map((section) => (section.querySelector('[data-slot="search-list-header"]') ?? section.querySelector('[data-slot="search-list-row"]'))?.getBoundingClientRect().top)
        .find((top) => top !== undefined)

      setMetrics({
        stride,
        rowHeight,
        headerHeight,
        leading,
        after: next === undefined ? 0 : Math.max(0, next - lastEnd),
      })

      return
    }
  }

  const sectionOf = (item: T) => props.section?.(item) ?? ""
  const open = () => props.open ?? true
  const topFade = () => props.topFade ?? true

  // Sections in the order their first row arrives; rows then list section by section, which is also the arrow order.
  const groups = createMemo(() => {
    const all = new Map<string, T[]>()

    props.items.forEach((item) => {
      const list = all.get(sectionOf(item))

      if (list) list.push(item)
      else all.set(sectionOf(item), [item])
    })

    return all
  })

  const rows = createMemo(() => [...groups().values()].flat())
  const byKey = createMemo(() => new Map(rows().map((item) => [props.key(item), item] as const)))
  const sectionKeys = createMemo<string[]>((previous) => stable(previous, [...groups().keys()]))

  createEffect(
    on(
      sectionKeys,
      () => {
        if (!props.windowed || metrics()) return
        const frame = requestAnimationFrame(() => requestAnimationFrame(measureWindow))
        onCleanup(() => cancelAnimationFrame(frame))
      },
    ),
  )

  const layout = createMemo(() => {
    const m = metrics()
    const stride = m?.stride ?? 34
    const headerHeight = m?.headerHeight ?? 0
    const leading = m?.leading ?? 0
    const after = m?.after ?? 2
    let running = 0

    return [...groups().entries()].map(([key, items]) => {
      const hasHeader = !!props.header && items.length > 0
      const start = running + (hasHeader ? headerHeight + leading : 0)

      running += (hasHeader ? headerHeight + leading : 0) + Math.max(0, items.length - 1) * stride + (m?.rowHeight ?? stride - 1) + after

      return { key, items, stride, start, after }
    })
  })

  const windowedSections = createMemo(() => {
    const top = scrollTop()
    const bottom = top + (viewportHeight() || 600)

    return layout().map((section) => {
      const count = section.items.length
      const from = Math.min(count, Math.max(0, Math.floor((top - section.start) / section.stride) - OVERSCAN))
      const to = Math.max(from, Math.min(count, Math.ceil((bottom - section.start) / section.stride) + OVERSCAN))

      return { ...section, from, to }
    })
  })

  const typeahead = createTypeahead<T>({
    items: rows,
    key: (item) => props.key(item),
    onSelect: (item) => props.onSelect(item),
    onClose: props.onClose && (() => props.onClose?.()),
  })

  const activeKey = createMemo(() => {
    const item = typeahead.activeItem()

    return item === undefined ? undefined : props.key(item)
  })

  // Moving the highlight updates the two rows it leaves and lands on, not every row.
  const isActive = createSelector(activeKey)

  // The first row shows from the top, so its header is never hidden; any other row scrolls in only as far as needed.
  const reveal = () => {
    const item = typeahead.activeItem()

    if (!viewport) return

    if (item === undefined || item === rows()[0]) return viewport.scrollTo({ top: 0 })

    if (windowed() && !document.getElementById(typeahead.optionID(item))) {
      const section = layout().find((candidate) => candidate.items.includes(item))
      const index = section?.items.indexOf(item) ?? -1

      if (section && index >= 0) {
        const top = section.start + index * section.stride
        const bottom = top + section.stride - 1
        const header = document.getElementById(`${typeahead.listID}-section-${encodeURIComponent(section.key)}`)
          ?.querySelector<HTMLElement>('[data-slot="search-list-header"]')?.offsetHeight ?? 0
        const visibleTop = viewport.scrollTop + header

        if (top < visibleTop) return viewport.scrollTo({ top: Math.max(0, top - header - 4) })
        if (bottom > viewport.scrollTop + viewport.clientHeight)
          return viewport.scrollTo({ top: bottom - viewport.clientHeight + 4 })

        return
      }
    }

    document.getElementById(typeahead.optionID(item))?.scrollIntoView({ block: "nearest" })
  }

  // Rows fade out where they run under the top header or past the bottom edge. Each fade reaches full strength once
  // 15 px is hidden, so it eases in with the scroll. The top fade follows the header over the topmost section and
  // measures what that section has hidden, so a header that pushes the last one away starts clear again. Sections and
  // scroll extent are measured when the list lays out, so scrolling only does arithmetic.
  let sections: { top: number; bottom: number; header: number }[] = []
  let maxScroll = 0
  const lastFade = { offset: "", top: "", bottom: "" }

  const edges = (scroll: number) => {
    if (!viewport) return
    const strength = (hidden: number) => String(Math.min(1, Math.max(0, hidden / 15)))

    if (topFade() && fade) {
      const current = sections.findLast((section) => section.top - scroll < section.header)

      // A stuck header sits at the top until its section's end pushes it up.
      const offset = current?.header
        ? Math.min(Math.max(current.top - scroll, 0) + current.header, current.bottom - scroll)
        : 0

      const nextOffset = `${Math.max(0, offset)}px`
      const nextTop = strength(current ? scroll - current.top : 0)

      if (lastFade.offset !== nextOffset) {
        lastFade.offset = nextOffset
        fade.style.setProperty("--search-list-fade-offset", nextOffset)
      }

      if (lastFade.top !== nextTop) {
        lastFade.top = nextTop
        fade.style.setProperty("--search-list-fade-top", nextTop)
      }
    }

    const nextBottom = strength(maxScroll - scroll)

    if (lastFade.bottom !== nextBottom) {
      lastFade.bottom = nextBottom
      viewport.style.setProperty("--search-list-fade-bottom", nextBottom)
    }
  }

  const measure = () => {
    if (!viewport) return
    const scroll = viewport.scrollTop
    setViewportHeight(viewport.clientHeight)
    maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight)

    if (topFade()) {
      const origin = viewport.getBoundingClientRect().top - scroll

      sections = [...viewport.querySelectorAll<HTMLElement>('[data-slot="search-list-section"]')].map((section) => {
        const rect = section.getBoundingClientRect()

        // A sticky header stays inside its section's content box, so the section's bottom padding is out of its reach.
        return {
          top: rect.top - origin,
          bottom: rect.bottom - origin - parseFloat(getComputedStyle(section).paddingBottom),
          header: section.querySelector<HTMLElement>('[data-slot="search-list-header"]')?.offsetHeight ?? 0,
        }
      })
    }

    edges(scroll)
  }

  createResizeObserver(() => [viewport, results], measure)
  createEffect(
    on(
      rows,
      () => measure(),
      { defer: true },
    ),
  )

  createEffect(() => props.onActive?.(typeahead.activeItem()))

  // A new query starts from the top. Results that arrive later for the same query bring a chosen row back into view,
  // but leave the list where the wheel put it while the first row is still the default or the pointer took the row.
  let revealed = props.query
  let pointed: string | undefined

  createEffect(
    on(
      rows,
      (all) => {
        const fresh = props.query !== revealed
        revealed = props.query

        if (!fresh && (typeahead.activeItem() === all[0] || activeKey() === pointed)) return
        const frame = requestAnimationFrame(reveal)
        onCleanup(() => cancelAnimationFrame(frame))
      },
      { defer: true },
    ),
  )

  const choose = (key: string | undefined, input?: "pointer") => {
    pointed = input === "pointer" ? key : undefined
    typeahead.setActive(key)
  }

  props.ref?.({ active: typeahead.activeItem, setActive: choose })

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return
    props.onKeyDown?.(event, typeahead.activeItem())

    if (event.defaultPrevented || !open()) return
    const move = searchListMove(event)

    if (!move) return typeahead.onKeyDown(event)
    event.preventDefault()
    event.stopPropagation()
    const all = rows()
    const sections = all.map(sectionOf)
    const active = typeahead.activeItem()
    const from = active === undefined ? -1 : all.indexOf(active)

    const step = (index: number): number => {
      const next = searchListTarget(sections, index, move)
      const copy = (move === "next" || move === "previous") && active !== undefined && next !== from

      return copy && props.same?.(all[next]!, active) ? step(next) : next
    }

    const target = all[step(from)]

    if (target === undefined) return
    choose(props.key(target))
    reveal()
  }

  onMount(() => {
    if (viewport && props.scrollTop) viewport.scrollTop = props.scrollTop
  })

  const field: SearchListField = {
    role: "combobox",
    get "aria-expanded"() {
      return open()
    },
    "aria-autocomplete": "list",
    get "aria-controls"() {
      return open() ? typeahead.listID : undefined
    },
    get "aria-activedescendant"() {
      return open() ? typeahead.activeID() : undefined
    },
    onInput: (event) => {
      // A new query starts again from its first row.
      choose(undefined)
      const value = event.currentTarget.value

      setText(value)
      clearTimeout(queryTimer)
      if (debounce()) queryTimer = setTimeout(() => props.onQuery(value), debounce())
      else props.onQuery(value)
    },
    onKeyDown,
  }

  const row = (key: string, item: () => T): SearchListRow => ({
    get id() {
      return typeahead.optionID(item())
    },
    role: "option",
    get "aria-selected"() {
      return isActive(key)
    },
    "data-slot": "search-list-row",
    get "data-active"() {
      return isActive(key) ? ("" as const) : undefined
    },
    onMouseMove: (event) => {
      // A static cursor must not take the active row while the keyboard scrolls rows beneath it.
      if (event.movementX === 0 && event.movementY === 0) return
      pointed = key
      typeahead.setActive(key)
    },
    // Focus stays in the field.
    onMouseDown: (event) => event.preventDefault(),
    onClick: () => props.onSelect(item()),
  })

  // Every highlighted row reads this, so the query is trimmed and lower-cased once per keystroke, not once per row.
  const needle = createMemo(() => props.query.trim().toLowerCase())

  return (
    <QueryContext.Provider value={needle}>
      <div data-component="search-list" data-popover={props.popover ? "" : undefined} class={props.class}>
        <Show
          when={props.field}
          fallback={
            <div data-slot="search-list-search">
              <TextInput
                {...field}
                value={text()}
                autofocus
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                spellcheck={false}
                appearance="large"
                placeholder={props.placeholder}
                aria-label={props.placeholder}
                leadingIcon={<Icon name="magnifying-glass" />}
                trailing={props.trailing}
              />
            </div>
          }
        >
          {(custom) => custom()(field)}
        </Show>
        <div data-slot="search-list-body" hidden={!open()}>
          <MenuScroll
            data-slot="search-list-scroll"
            viewportRef={(element) => (viewport = element)}
            onScroll={(event) => {
              const top = event.currentTarget.scrollTop
              setScrollTop(top)
              // Callers read clean layout before edge-fade properties mutate the viewport.
              props.onScroll?.(top)
              edges(top)
            }}
          >
            <Show when={topFade()}>
              <div ref={fade} data-slot="search-list-fade" aria-hidden="true" />
            </Show>
            <div
              ref={results}
              id={typeahead.listID}
              data-slot="search-list-results"
              role="listbox"
              hidden={rows().length === 0}
              aria-label={props.label ?? props.placeholder}
            >
              <For each={sectionKeys()}>
                {(section) => {
                  const window = createMemo(() =>
                    windowed() ? windowedSections().find((entry) => entry.key === section) : undefined,
                  )
                  const all = createMemo<string[]>((previous) =>
                    stable(previous, (groups().get(section) ?? []).map(props.key)),
                  )
                  const keys = createMemo<string[]>((previous) => {
                    const range = window()

                    return stable(
                      previous,
                      range ? all().slice(range.from, range.to) : all(),
                    )
                  })

                  const first = () => byKey().get(all()[0] ?? "")

                  const header = createMemo(() =>
                    props.header && first() !== undefined ? props.header(first()!) : undefined,
                  )

                  const id = `${typeahead.listID}-section-${encodeURIComponent(section)}`

                  return (
                    <div
                      data-slot="search-list-section"
                      data-key={section}
                      data-windowed={windowed() ? "" : undefined}
                      role="group"
                      aria-labelledby={header() ? id : undefined}
                    >
                      <Show when={header()}>
                        {(content) => (
                          <div id={id} data-slot="search-list-header">
                            {content()}
                          </div>
                        )}
                      </Show>
                      <Show when={window() && window()!.from > 0}>
                        <div
                          data-slot="search-list-spacer"
                          style={{ height: `${window()!.from * window()!.stride}px` }}
                        />
                      </Show>
                      <div data-slot="search-list-window-rows">
                        <For each={keys()}>
                          {(key) => {
                            // A row that is leaving keeps its last item until it is removed.
                            const item = createMemo<T>((previous) => byKey().get(key) ?? previous, byKey().get(key)!)

                            return props.children(item, row(key, item))
                          }}
                        </For>
                      </div>
                      <Show when={window() && window()!.to < all().length}>
                        <div
                          data-slot="search-list-spacer"
                          style={{
                            height: `${(all().length - window()!.to) * window()!.stride + window()!.after}px`,
                          }}
                        />
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
            <Show when={rows().length === 0}>
              <div data-slot="search-list-empty">{props.empty}</div>
            </Show>
          </MenuScroll>
          <Show when={props.footer}>
            <div data-slot="search-list-footer">{props.footer}</div>
          </Show>
        </div>
      </div>
    </QueryContext.Provider>
  )
}

/** Text with its first match for the list's query marked. One mark per row keeps short queries from speckling the list. */
export function SearchHighlight(props: { text: string }) {
  const needle = useContext(QueryContext)
  const haystack = createMemo(() => props.text.toLowerCase())

  const match = createMemo(() => {
    const at = needle() ? haystack().indexOf(needle()) : -1

    // Lower-casing a few scripts changes the length, and then offsets no longer line up with the text.
    if (at === -1 || haystack().length !== props.text.length) return

    return { at, end: at + needle().length }
  })

  return (
    <Show when={match()} fallback={props.text}>
      {(range) => (
        <>
          {props.text.slice(0, range().at)}
          <mark data-slot="search-list-match">{props.text.slice(range().at, range().end)}</mark>
          {props.text.slice(range().end)}
        </>
      )}
    </Show>
  )
}

function stable(previous: string[] | undefined, next: string[]) {
  return previous && previous.length === next.length && previous.every((value, index) => value === next[index])
    ? previous
    : next
}
