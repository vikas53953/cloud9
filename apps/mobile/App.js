// Cloud9 iPhone app (Expo) — chat surface + notifications remote for your crew.
// Same WS protocol as desktop. Run with Expo Go while TestFlight is pending:
//   cd apps/mobile && npm install && npx expo start   → scan QR with iPhone.
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList, KeyboardAvoidingView, Platform, SafeAreaView, StatusBar, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from "react-native";
import * as Notifications from "expo-notifications";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false }),
});

const DEFAULT_RELAY = "ws://192.168.1.10:8787"; // point at your desktop/relay

export default function App() {
  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY);
  const [token, setToken] = useState("");
  const [invite, setInvite] = useState("");
  const [name, setName] = useState("");
  const [world, setWorld] = useState(null);
  const [messages, setMessages] = useState({});
  const [activeId, setActiveId] = useState(null);
  const [draft, setDraft] = useState("");
  const wsRef = useRef(null);

  const connect = (authToken) => {
    const ws = new WebSocket(relayUrl);
    wsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token: authToken, client: "mobile" }));
    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data);
      if (f.type === "welcome") {
        setWorld(f.state);
        const byChan = {};
        for (const m of f.state.messages) (byChan[m.channelId] ??= []).push(m);
        setMessages(byChan);
      } else if (f.type === "token") {
        setToken(f.token);
      } else if (f.type === "message") {
        setMessages((prev) => ({
          ...prev,
          [f.message.channelId]: [...(prev[f.message.channelId] ?? []), f.message],
        }));
      } else if (f.type === "push") {
        Notifications.scheduleNotificationAsync({
          content: { title: `☁️ ${f.message.authorName}`, body: f.message.text.slice(0, 140) },
          trigger: null,
        });
      } else if (f.type === "channel") {
        setWorld((w) => w && ({
          ...w,
          channels: w.channels.some((c) => c.id === f.channel.id)
            ? w.channels.map((c) => (c.id === f.channel.id ? f.channel : c))
            : [...w.channels, f.channel],
        }));
      }
    };
    ws.onclose = () => setTimeout(() => wsRef.current === ws && connect(authToken), 3000);
  };

  const join = () => connect(token || `invite:${invite.trim()}:${name.trim() || "Friend"}`);

  const send = () => {
    if (!draft.trim() || !activeId) return;
    wsRef.current?.send(JSON.stringify({ type: "send", channelId: activeId, text: draft.trim() }));
    setDraft("");
  };

  const active = world?.channels.find((c) => c.id === activeId);
  const nameOf = (m) => (m.authorEmoji ? `${m.authorEmoji} ` : "") + m.authorName;

  if (!world) {
    return (
      <SafeAreaView style={s.root}>
        <StatusBar barStyle="light-content" />
        <View style={s.join}>
          <Text style={s.h1}>☁️ Cloud9</Text>
          <TextInput style={s.input} value={relayUrl} onChangeText={setRelayUrl} placeholder="Relay URL" placeholderTextColor="#69718a" autoCapitalize="none" />
          <TextInput style={s.input} value={token} onChangeText={setToken} placeholder="Token (if you have one)" placeholderTextColor="#69718a" autoCapitalize="none" />
          <Text style={s.or}>— or join with an invite —</Text>
          <TextInput style={s.input} value={invite} onChangeText={setInvite} placeholder="Invite code (inv_…)" placeholderTextColor="#69718a" autoCapitalize="none" />
          <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Your name" placeholderTextColor="#69718a" />
          <TouchableOpacity style={s.btn} onPress={join}><Text style={s.btnText}>Enter Cloud9</Text></TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (!active) {
    return (
      <SafeAreaView style={s.root}>
        <StatusBar barStyle="light-content" />
        <Text style={s.h2}>Channels</Text>
        <FlatList
          data={world.channels}
          keyExtractor={(c) => c.id}
          renderItem={({ item }) => (
            <TouchableOpacity style={s.chanRow} onPress={() => setActiveId(item.id)}>
              <Text style={s.chanText}>{item.kind === "dm" ? "💬" : "#"} {item.name}</Text>
            </TouchableOpacity>
          )}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" />
      <View style={s.head}>
        <TouchableOpacity onPress={() => setActiveId(null)}><Text style={s.back}>‹ Back</Text></TouchableOpacity>
        <Text style={s.h2}>{active.kind === "dm" ? active.name : `# ${active.name}`}</Text>
      </View>
      <FlatList
        style={{ flex: 1 }}
        data={messages[active.id] ?? []}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => (
          <View style={s.msg}>
            <Text style={s.who}>{nameOf(item)} {item.proactive ? "⏰" : ""}</Text>
            <Text style={s.text}>{item.text}</Text>
          </View>
        )}
      />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={s.composer}>
          <TextInput style={s.cinput} value={draft} onChangeText={setDraft} placeholder="Message… (@ to call an agent)" placeholderTextColor="#69718a" />
          <TouchableOpacity style={s.send} onPress={send}><Text style={s.btnText}>↑</Text></TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#10131c" },
  join: { flex: 1, justifyContent: "center", padding: 24, gap: 10 },
  h1: { color: "#e8ebf4", fontSize: 28, fontWeight: "800", textAlign: "center", marginBottom: 14 },
  h2: { color: "#e8ebf4", fontSize: 17, fontWeight: "700", padding: 14 },
  or: { color: "#69718a", textAlign: "center", fontSize: 12 },
  input: { backgroundColor: "#1d2334", borderColor: "#303952", borderWidth: 1, borderRadius: 10, color: "#e8ebf4", padding: 12 },
  btn: { backgroundColor: "#4a5df0", borderRadius: 10, padding: 14, alignItems: "center", marginTop: 6 },
  btnText: { color: "#fff", fontWeight: "700" },
  chanRow: { padding: 14, borderBottomColor: "#262c3f", borderBottomWidth: 1 },
  chanText: { color: "#ccd3e8", fontSize: 16 },
  head: { flexDirection: "row", alignItems: "center", borderBottomColor: "#262c3f", borderBottomWidth: 1 },
  back: { color: "#7ea2ff", padding: 14, fontSize: 16 },
  msg: { paddingHorizontal: 14, paddingVertical: 6 },
  who: { color: "#8b93a7", fontSize: 12, fontWeight: "700" },
  text: { color: "#e8ebf4", fontSize: 15, marginTop: 2 },
  composer: { flexDirection: "row", padding: 10, gap: 8 },
  cinput: { flex: 1, backgroundColor: "#1d2334", borderColor: "#303952", borderWidth: 1, borderRadius: 10, color: "#e8ebf4", padding: 12 },
  send: { backgroundColor: "#4a5df0", borderRadius: 10, paddingHorizontal: 16, justifyContent: "center" },
});
