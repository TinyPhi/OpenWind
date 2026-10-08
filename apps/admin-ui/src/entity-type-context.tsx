import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
} from "react";
import { fetchWithAuth, API_URL } from "./lib/api.js";

export type EntityType = {
  id: string;
  name: string;
  plural: string;
  icon: string | null;
  moduleId: string | null;
};

export type Module = {
  id: string;
  slug: string;
  name: string;
  description?: string;
  installed: boolean;
};

type EntityTypeContextValue = {
  entityTypes: EntityType[];
  modules: Module[];
  getTypeBySlug: (slug: string) => EntityType | undefined;
  getTypeById: (id: string) => EntityType | undefined;
  reload: () => void;
};

export function toTypeSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

const EntityTypeContext = createContext<EntityTypeContextValue>({
  entityTypes: [],
  modules: [],
  getTypeBySlug: () => undefined,
  getTypeById: () => undefined,
  reload: () => {},
});

export function EntityTypeProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [entityTypes, setEntityTypes] = useState<EntityType[]>([]);
  const [modules, setModules] = useState<Module[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // GET /entity-types is cursor-paginated (100/page) -- a single fetch
    // silently truncated this context to page 1, so any tenant with 100+
    // entity types (e.g. leftover e2e-test fixtures) could have a real
    // entity type like "ticket" simply never show up here, anywhere it's
    // looked up by name/slug, with no error at all. Page through every
    // cursor so `entityTypes` is always the tenant's complete set.
    async function loadAllEntityTypes(): Promise<EntityType[]> {
      const all: EntityType[] = [];
      let cursor: string | undefined;
      for (;;) {
        const res = (await fetchWithAuth(
          `${API_URL}/entity-types${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        )) as { data?: EntityType[]; nextCursor?: string | null };
        all.push(...(res.data ?? []));
        if (!res.nextCursor) break;
        cursor = res.nextCursor;
      }
      return all;
    }

    void Promise.allSettled([
      loadAllEntityTypes(),
      fetchWithAuth(`${API_URL}/modules`),
    ]).then(([etRes, modRes]) => {
      if (cancelled) return;
      if (etRes.status === "fulfilled") {
        setEntityTypes(etRes.value);
      }
      if (modRes.status === "fulfilled") {
        setModules((modRes.value as { data?: Module[] }).data ?? []);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [tick]);

  const getTypeBySlug = useCallback(
    (slug: string): EntityType | undefined => {
      return entityTypes.find(
        (et) =>
          toTypeSlug(et.name) === slug ||
          toTypeSlug(et.plural || et.name) === slug,
      );
    },
    [entityTypes],
  );

  const getTypeById = useCallback(
    (id: string): EntityType | undefined => {
      return entityTypes.find((et) => et.id === id);
    },
    [entityTypes],
  );

  const reload = useCallback((): void => {
    setTick((t) => t + 1);
  }, []);

  const contextValue = useMemo(
    (): EntityTypeContextValue => ({
      entityTypes,
      modules,
      getTypeBySlug,
      getTypeById,
      reload,
    }),
    [entityTypes, modules, getTypeBySlug, getTypeById, reload],
  );

  return (
    <EntityTypeContext.Provider value={contextValue}>
      {children}
    </EntityTypeContext.Provider>
  );
}

export function useEntityTypes(): EntityTypeContextValue {
  return useContext(EntityTypeContext);
}
