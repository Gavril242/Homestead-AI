// Multi-agent Pub/Sub event bus.
//
// Replaces ad-hoc WebSocket broadcasts with a structured event system
// that agents can subscribe to, publish on, and replay from.
//
// Predefined channels:
//   task:lifecycle    — task created, started, finished, failed
//   agent:chat        — agent chat messages
//   system:alerts     — errors, quota warnings, restores
//   workspace:changes — file writes, deletes in workspaces

class EventBus {
  constructor() {
    /** @type {Map<string, Set<{agentId: string, handler: Function}>>} */
    this.channels = new Map();
    /** @type {Array<{channel: string, type: string, source: string, data: any, timestamp: number}>} */
    this.history = [];
    this.MAX_HISTORY = 200;
  }

  /**
   * Subscribe an agent to a channel.
   * @param {string} channel
   * @param {string} agentId
   * @param {Function} handler — called with (event) on each publish
   * @returns {{ ok: true, channel: string, agentId: string }}
   */
  subscribe(channel, agentId, handler) {
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set());
    }
    // Remove any existing subscription for this agent on this channel
    const subs = this.channels.get(channel);
    for (const sub of subs) {
      if (sub.agentId === agentId) {
        subs.delete(sub);
        break;
      }
    }
    subs.add({ agentId, handler });
    return { ok: true, channel, agentId };
  }

  /**
   * Unsubscribe an agent from a channel.
   * @param {string} channel
   * @param {string} agentId
   * @returns {{ ok: true, removed: boolean }}
   */
  unsubscribe(channel, agentId) {
    const subs = this.channels.get(channel);
    if (!subs) return { ok: true, removed: false };
    let removed = false;
    for (const sub of subs) {
      if (sub.agentId === agentId) {
        subs.delete(sub);
        removed = true;
        break;
      }
    }
    return { ok: true, removed };
  }

  /**
   * Publish an event to a channel. Returns number of handlers notified.
   * @param {string} channel
   * @param {{ type: string, source: string, data: any, timestamp?: number }} event
   * @returns {number} handlers notified
   */
  publish(channel, event) {
    const stamped = {
      channel,
      type: event.type,
      source: event.source,
      data: event.data,
      timestamp: event.timestamp || Date.now(),
    };

    // Store in history (ring buffer)
    this.history.push(stamped);
    if (this.history.length > this.MAX_HISTORY) {
      this.history = this.history.slice(-this.MAX_HISTORY);
    }

    let notified = 0;

    // Fan out to channel subscribers
    const subs = this.channels.get(channel);
    if (subs) {
      for (const { handler } of subs) {
        try {
          handler(stamped);
          notified++;
        } catch (err) {
          console.error(`[event-bus] handler error on ${channel}:`, err.message);
        }
      }
    }

    // Fan out to wildcard subscribers
    const wildcardSubs = this.channels.get('*');
    if (wildcardSubs) {
      for (const { handler } of wildcardSubs) {
        try {
          handler(stamped);
          notified++;
        } catch (err) {
          console.error(`[event-bus] wildcard handler error:`, err.message);
        }
      }
    }

    return notified;
  }

  /**
   * Get recent events on a channel (for agent context injection).
   * @param {string} channel
   * @param {Date|number} since — only events after this time
   * @param {number} limit — max events to return (default 20)
   * @returns {Array}
   */
  replay(channel, since, limit = 20) {
    const sinceMs = since instanceof Date ? since.getTime() : (since || 0);
    return this.history
      .filter(e => e.channel === channel && e.timestamp > sinceMs)
      .slice(-limit);
  }

  /**
   * List all channels and subscriber counts.
   * @returns {Array<{ channel: string, subscribers: number }>}
   */
  inspect() {
    const result = [];
    for (const [channel, subs] of this.channels) {
      result.push({
        channel,
        subscribers: subs.size,
        agents: [...subs].map(s => s.agentId),
      });
    }
    return result;
  }
}

export const bus = new EventBus();
