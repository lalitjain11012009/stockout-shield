// Shared account session, saved stock, and isolated guest-session data.
// Inventory and Import both read from this single source of truth.
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase.js";
import { MEDICINES, stockMedicines } from "../lib/forecast.js";

const GUEST_KEY = "stockout-shield-guest-v1";
const StockContext = createContext(null);

function readGuest() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(GUEST_KEY) ?? "null");
    return Array.isArray(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function StockProvider({ children }) {
  const [user, setUser] = useState(null);
  const [guest, setGuest] = useState(readGuest);
  const [rows, setRows] = useState([]);
  const [ready, setReady] = useState(!supabase);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
      if (event === "PASSWORD_RECOVERY" && window.location.pathname !== "/reset-password")
        window.location.assign(`/reset-password${window.location.hash}`);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const refresh = useCallback(async () => {
    if (!user || !supabase) {
      setRows([]);
      return;
    }
    const { data, error } = await supabase
      .from("medicine_stock")
      .select("id,name,category,stock,daily_usage,expiry_date")
      .order("name");
    if (error) throw error;
    setRows(data ?? []);
  }, [user]);

  useEffect(() => {
    refresh().catch(() => setRows([]));
  }, [refresh]);

  // Live updates: any insert/update/delete on this user's stock (e.g. from another tab or
  // device) refreshes every page. Row-level security limits events to the user's own rows.
  useEffect(() => {
    if (!user || !supabase) return;
    const channel = supabase
      .channel(`medicine_stock:${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "medicine_stock", filter: `user_id=eq.${user.id}` },
        () => refresh().catch(() => {}),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, refresh]);

  function updateGuest(next) {
    sessionStorage.setItem(GUEST_KEY, JSON.stringify(next));
    setGuest(next);
  }

  async function add(incoming) {
    if (guest !== null) {
      // eslint-disable-next-line no-unused-vars
      updateGuest([...guest, ...incoming.map(({ extra, ...row }) => ({ ...row, id: crypto.randomUUID() }))]);
      return;
    }
    if (!supabase) throw new Error("Supabase is not configured.");
    const { error } = await supabase.from("medicine_stock").insert(incoming);
    if (error) throw error;
    await refresh();
  }

  async function remove(id) {
    if (guest !== null) {
      updateGuest(guest.filter((row) => row.id !== id));
      return;
    }
    if (!supabase) throw new Error("Supabase is not configured.");
    const { error } = await supabase.from("medicine_stock").delete().eq("id", id);
    if (error) throw error;
    await refresh();
  }

  function enterGuest() {
    updateGuest(
      MEDICINES.map((m) => ({
        id: m.id,
        name: m.name,
        category: m.id === "para" ? "Pain relief" : m.category,
        stock: m.stock,
        daily_usage: m.base,
        expiry_date: "2027-12-31",
      })),
    );
  }

  async function leave() {
    if (guest !== null) {
      sessionStorage.removeItem(GUEST_KEY);
      setGuest(null);
    } else if (supabase) {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    }
  }

  const activeRows = guest ?? rows;
  // Signed-in users and guests forecast their own stock; logged-out visitors see the demo set.
  const isDemo = !user && guest === null;
  const medicines = isDemo ? MEDICINES : stockMedicines(activeRows);

  const value = { user, guest, ready, rows: activeRows, medicines, isDemo, refresh, add, remove, enterGuest, leave };
  return <StockContext.Provider value={value}>{children}</StockContext.Provider>;
}

export function useStock() {
  const value = useContext(StockContext);
  if (!value) throw new Error("StockProvider is required");
  return value;
}
