import { createContext, useContext, useEffect, useState } from "react";
import { api, clearSession, getSession, setSession, subscribeSession } from "./api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSessionState] = useState(getSession);
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(Boolean(getSession()?.accessToken));

  useEffect(() => subscribeSession(setSessionState), []);

  useEffect(() => {
    let active = true;
    if (!getSession()?.accessToken) {
      setUser(null);
      setBooting(false);
      return undefined;
    }
    api.auth.me()
      .then((result) => {
        if (active) setUser(result.user);
      })
      .catch(() => {
        clearSession();
        if (active) setUser(null);
      })
      .finally(() => {
        if (active) setBooting(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function login(credentials) {
    const result = await api.auth.login(credentials);
    setSession(result);
    setUser(result.user);
    return result.user;
  }

  async function register(details) {
    const result = await api.auth.registerDonor(details);
    setSession(result);
    setUser(result.user);
    return result.user;
  }

  async function logout() {
    const current = getSession();
    try {
      if (current?.refreshToken) await api.auth.logout(current.refreshToken);
    } finally {
      clearSession();
      setUser(null);
    }
  }

  return (
    <AuthContext.Provider value={{ user, session, booting, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
