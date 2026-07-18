import { Check, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { PiModel } from "@/lib/types";

export function ModelPicker({
  open,
  onOpenChange,
  models,
  selected,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: PiModel[];
  selected?: PiModel;
  onSelect: (model: PiModel) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.toLowerCase().trim();
    return models.filter((model) =>
      `${model.provider} ${model.name ?? model.id} ${model.id}`.toLowerCase().includes(needle),
    );
  }, [models, query]);
  const groups = useMemo(() => {
    const result = new Map<string, PiModel[]>();
    for (const model of filtered) {
      result.set(model.provider, [...(result.get(model.provider) ?? []), model]);
    }
    return result;
  }, [filtered]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="picker-dialog">
        <DialogHeader>
          <DialogTitle>Choose model</DialogTitle>
        </DialogHeader>
        <label className="picker-search">
          <Search size={14} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models"
          />
        </label>
        <div className="picker-list">
          {[...groups.entries()].map(([provider, providerModels]) => (
            <section key={provider}>
              <h3>{provider}</h3>
              {providerModels.map((model) => {
                const active = selected?.provider === model.provider && selected?.id === model.id;
                return (
                  <button
                    type="button"
                    className="model-row"
                    data-active={active}
                    key={`${model.provider}/${model.id}`}
                    onClick={() => {
                      onSelect(model);
                      onOpenChange(false);
                    }}
                  >
                    <span>
                      <strong>{model.name ?? model.id}</strong>
                      <small>{model.id}</small>
                    </span>
                    {model.contextWindow && (
                      <small>{Math.round(model.contextWindow / 1000)}k</small>
                    )}
                    {active && <Check size={14} />}
                  </button>
                );
              })}
            </section>
          ))}
          {!filtered.length && <div className="picker-empty">No matching models</div>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
