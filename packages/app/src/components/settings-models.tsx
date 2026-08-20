import { useFilteredList } from "@opencode-ai/ui/hooks"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/switch"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { type Component, createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { useServerSDK } from "@/context/server-sdk"
import { popularProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"
import { SettingsList } from "./settings-list"
import { SettingsServerPicker, SettingsServerScope } from "./settings-server-picker"

type ModelItem = ReturnType<ReturnType<typeof useModels>["list"]>[number]

const ListLoadingState: Component<{ label: string }> = (props) => {
  return (
    <div class="flex flex-col items-center justify-center py-12 text-center">
      <span class="text-14-regular text-text-weak">{props.label}</span>
    </div>
  )
}

const ListEmptyState: Component<{ message: string; filter: string }> = (props) => {
  return (
    <div class="flex flex-col items-center justify-center py-12 text-center">
      <span class="text-14-regular text-text-weak">{props.message}</span>
      <Show when={props.filter}>
        <span class="text-14-regular text-text-strong mt-1">&quot;{props.filter}&quot;</span>
      </Show>
    </div>
  )
}

export const SettingsModels: Component = () => {
  return (
    <SettingsServerScope>
      <SettingsModelsContent />
    </SettingsServerScope>
  )
}

const SettingsModelsContent: Component = () => {
  const language = useLanguage()
  const models = useModels()
  const serverSdk = useServerSDK()
  const [store, setStore] = persisted(
    Persist.serverGlobal(serverSdk().scope, "settings.models"),
    createStore({ collapsed: {} as Record<string, boolean>, provider: null as string | null }),
  )

  const providerOptions = createMemo(() => {
    const seen = new Set<string>()
    const list: { id: string; name: string }[] = []
    for (const item of models.list()) {
      if (seen.has(item.provider.id)) continue
      seen.add(item.provider.id)
      list.push({ id: item.provider.id, name: item.provider.name })
    }
    return list.sort((a, b) => {
      const aIndex = popularProviders.indexOf(a.id)
      const bIndex = popularProviders.indexOf(b.id)
      const aPopular = aIndex >= 0
      const bPopular = bIndex >= 0
      if (aPopular && !bPopular) return -1
      if (!aPopular && bPopular) return 1
      if (aPopular && bPopular) return aIndex - bIndex
      return a.name.localeCompare(b.name)
    })
  })

  const allProviders = () => ({ id: null as string | null, name: language.t("settings.models.filter.all") })

  const list = useFilteredList<ModelItem>({
    items: (_filter) =>
      store.provider ? models.list().filter((item) => item.provider.id === store.provider) : models.list(),
    key: (x) => `${x.provider.id}:${x.id}`,
    filterKeys: ["provider.name", "name", "id"],
    sortBy: (a, b) => a.name.localeCompare(b.name),
    groupBy: (x) => x.provider.id,
    sortGroupsBy: (a, b) => {
      const aIndex = popularProviders.indexOf(a.category)
      const bIndex = popularProviders.indexOf(b.category)
      const aPopular = aIndex >= 0
      const bPopular = bIndex >= 0

      if (aPopular && !bPopular) return -1
      if (!aPopular && bPopular) return 1
      if (aPopular && bPopular) return aIndex - bIndex

      const aName = a.items[0].provider.name
      const bName = b.items[0].provider.name
      return aName.localeCompare(bName)
    },
  })

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-4 pt-6 pb-6 max-w-[720px]">
          <div class="flex items-center justify-between gap-4">
            <h2 class="text-16-medium text-text-strong">{language.t("settings.models.title")}</h2>
            <SettingsServerPicker />
          </div>
          <div class="flex items-center gap-2">
            <div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base flex-1 min-w-0">
              <Icon name="magnifying-glass" class="text-icon-weak-base flex-shrink-0" />
              <TextField
                variant="ghost"
                type="text"
                value={list.filter()}
                onChange={list.onInput}
                placeholder={language.t("dialog.model.search.placeholder")}
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                class="flex-1"
              />
              <Show when={list.filter()}>
                <IconButton icon="circle-x" variant="ghost" onClick={list.clear} />
              </Show>
            </div>
            <SelectV2
              appearance="base"
              class="settings-models-provider-filter w-40 shrink-0"
              placeholder={language.t("settings.models.filter.provider")}
              value={(x) => (x.id ?? "all")}
              options={[allProviders(), ...providerOptions()]}
              current={
                store.provider
                  ? providerOptions().find((x) => x.id === store.provider) ?? allProviders()
                  : allProviders()
              }
              onSelect={(value) => setStore("provider", value?.id ?? null)}
            >
              {(item) => (
                <span class="flex min-w-0 items-center gap-2">
                  {item.id && <ProviderIcon id={item.id} class="size-4 shrink-0 icon-strong-base" />}
                  <span class="min-w-0 truncate">{item.name}</span>
                </span>
              )}
            </SelectV2>
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <Show
          when={!list.grouped.loading}
          fallback={
            <ListLoadingState label={`${language.t("common.loading")}${language.t("common.loading.ellipsis")}`} />
          }
        >
          <Show
            when={list.flat().length > 0}
            fallback={<ListEmptyState message={language.t("dialog.model.empty")} filter={list.filter()} />}
          >
            <For each={list.grouped.latest}>
              {(group) => {
                const searching = () => list.filter().length > 0
                const filtered = () => store.provider === group.category
                const expanded = () => searching() || filtered() || !store.collapsed[group.category]
                return (
                  <div class="flex flex-col gap-1">
                    <button
                      type="button"
                      class="group flex items-center gap-1 pb-2 text-left"
                      aria-expanded={expanded()}
                      disabled={searching() || filtered()}
                      onClick={() => setStore("collapsed", group.category, expanded())}
                    >
                      <Icon
                        name={expanded() ? "chevron-down" : "chevron-right"}
                        class="size-4 shrink-0 text-icon-weak-base transition-transform"
                      />
                      <ProviderIcon id={group.category} class="size-5 shrink-0 icon-strong-base" />
                      <span class="text-14-medium text-text-strong">{group.items[0].provider.name}</span>
                    </button>
                    <Show when={expanded()}>
                      <SettingsList>
                        <For each={group.items}>
                          {(item) => {
                            const key = { providerID: item.provider.id, modelID: item.id }
                            return (
                              <div class="flex flex-wrap items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none">
                                <div class="min-w-0">
                                  <span class="text-14-regular text-text-strong truncate block">{item.name}</span>
                                </div>
                                <div class="flex-shrink-0">
                                  <Switch
                                    checked={models.visible(key)}
                                    onChange={(checked) => {
                                      models.setVisibility(key, checked)
                                    }}
                                    hideLabel
                                  >
                                    {item.name}
                                  </Switch>
                                </div>
                              </div>
                            )
                          }}
                        </For>
                      </SettingsList>
                    </Show>
                  </div>
                )
              }}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  )
}
