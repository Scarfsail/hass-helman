/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const oe = globalThis, fe = oe.ShadowRoot && (oe.ShadyCSS === void 0 || oe.ShadyCSS.nativeShadow) && "adoptedStyleSheets" in Document.prototype && "replace" in CSSStyleSheet.prototype, ke = Symbol(), Ae = /* @__PURE__ */ new WeakMap();
let ot = class {
  constructor(e, t, i) {
    if (this._$cssResult$ = !0, i !== ke) throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");
    this.cssText = e, this.t = t;
  }
  get styleSheet() {
    let e = this.o;
    const t = this.t;
    if (fe && e === void 0) {
      const i = t !== void 0 && t.length === 1;
      i && (e = Ae.get(t)), e === void 0 && ((this.o = e = new CSSStyleSheet()).replaceSync(this.cssText), i && Ae.set(t, e));
    }
    return e;
  }
  toString() {
    return this.cssText;
  }
};
const xt = (a) => new ot(typeof a == "string" ? a : a + "", void 0, ke), at = (a, ...e) => {
  const t = a.length === 1 ? a[0] : e.reduce((i, o, r) => i + ((n) => {
    if (n._$cssResult$ === !0) return n.cssText;
    if (typeof n == "number") return n;
    throw Error("Value passed to 'css' function must be a 'css' function result: " + n + ". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.");
  })(o) + a[r + 1], a[0]);
  return new ot(t, a, ke);
}, zt = (a, e) => {
  if (fe) a.adoptedStyleSheets = e.map((t) => t instanceof CSSStyleSheet ? t : t.styleSheet);
  else for (const t of e) {
    const i = document.createElement("style"), o = oe.litNonce;
    o !== void 0 && i.setAttribute("nonce", o), i.textContent = t.cssText, a.appendChild(i);
  }
}, je = fe ? (a) => a : (a) => a instanceof CSSStyleSheet ? ((e) => {
  let t = "";
  for (const i of e.cssRules) t += i.cssText;
  return xt(t);
})(a) : a;
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const { is: At, defineProperty: jt, getOwnPropertyDescriptor: St, getOwnPropertyNames: Et, getOwnPropertySymbols: Mt, getPrototypeOf: Vt } = Object, C = globalThis, Se = C.trustedTypes, Ct = Se ? Se.emptyScript : "", de = C.reactiveElementPolyfillSupport, Q = (a, e) => a, ae = { toAttribute(a, e) {
  switch (e) {
    case Boolean:
      a = a ? Ct : null;
      break;
    case Object:
    case Array:
      a = a == null ? a : JSON.stringify(a);
  }
  return a;
}, fromAttribute(a, e) {
  let t = a;
  switch (e) {
    case Boolean:
      t = a !== null;
      break;
    case Number:
      t = a === null ? null : Number(a);
      break;
    case Object:
    case Array:
      try {
        t = JSON.parse(a);
      } catch {
        t = null;
      }
  }
  return t;
} }, we = (a, e) => !At(a, e), Ee = { attribute: !0, type: String, converter: ae, reflect: !1, useDefault: !1, hasChanged: we };
Symbol.metadata ?? (Symbol.metadata = Symbol("metadata")), C.litPropertyMetadata ?? (C.litPropertyMetadata = /* @__PURE__ */ new WeakMap());
let F = class extends HTMLElement {
  static addInitializer(e) {
    this._$Ei(), (this.l ?? (this.l = [])).push(e);
  }
  static get observedAttributes() {
    return this.finalize(), this._$Eh && [...this._$Eh.keys()];
  }
  static createProperty(e, t = Ee) {
    if (t.state && (t.attribute = !1), this._$Ei(), this.prototype.hasOwnProperty(e) && ((t = Object.create(t)).wrapped = !0), this.elementProperties.set(e, t), !t.noAccessor) {
      const i = Symbol(), o = this.getPropertyDescriptor(e, i, t);
      o !== void 0 && jt(this.prototype, e, o);
    }
  }
  static getPropertyDescriptor(e, t, i) {
    const { get: o, set: r } = St(this.prototype, e) ?? { get() {
      return this[t];
    }, set(n) {
      this[t] = n;
    } };
    return { get: o, set(n) {
      const l = o == null ? void 0 : o.call(this);
      r == null || r.call(this, n), this.requestUpdate(e, l, i);
    }, configurable: !0, enumerable: !0 };
  }
  static getPropertyOptions(e) {
    return this.elementProperties.get(e) ?? Ee;
  }
  static _$Ei() {
    if (this.hasOwnProperty(Q("elementProperties"))) return;
    const e = Vt(this);
    e.finalize(), e.l !== void 0 && (this.l = [...e.l]), this.elementProperties = new Map(e.elementProperties);
  }
  static finalize() {
    if (this.hasOwnProperty(Q("finalized"))) return;
    if (this.finalized = !0, this._$Ei(), this.hasOwnProperty(Q("properties"))) {
      const t = this.properties, i = [...Et(t), ...Mt(t)];
      for (const o of i) this.createProperty(o, t[o]);
    }
    const e = this[Symbol.metadata];
    if (e !== null) {
      const t = litPropertyMetadata.get(e);
      if (t !== void 0) for (const [i, o] of t) this.elementProperties.set(i, o);
    }
    this._$Eh = /* @__PURE__ */ new Map();
    for (const [t, i] of this.elementProperties) {
      const o = this._$Eu(t, i);
      o !== void 0 && this._$Eh.set(o, t);
    }
    this.elementStyles = this.finalizeStyles(this.styles);
  }
  static finalizeStyles(e) {
    const t = [];
    if (Array.isArray(e)) {
      const i = new Set(e.flat(1 / 0).reverse());
      for (const o of i) t.unshift(je(o));
    } else e !== void 0 && t.push(je(e));
    return t;
  }
  static _$Eu(e, t) {
    const i = t.attribute;
    return i === !1 ? void 0 : typeof i == "string" ? i : typeof e == "string" ? e.toLowerCase() : void 0;
  }
  constructor() {
    super(), this._$Ep = void 0, this.isUpdatePending = !1, this.hasUpdated = !1, this._$Em = null, this._$Ev();
  }
  _$Ev() {
    var e;
    this._$ES = new Promise((t) => this.enableUpdating = t), this._$AL = /* @__PURE__ */ new Map(), this._$E_(), this.requestUpdate(), (e = this.constructor.l) == null || e.forEach((t) => t(this));
  }
  addController(e) {
    var t;
    (this._$EO ?? (this._$EO = /* @__PURE__ */ new Set())).add(e), this.renderRoot !== void 0 && this.isConnected && ((t = e.hostConnected) == null || t.call(e));
  }
  removeController(e) {
    var t;
    (t = this._$EO) == null || t.delete(e);
  }
  _$E_() {
    const e = /* @__PURE__ */ new Map(), t = this.constructor.elementProperties;
    for (const i of t.keys()) this.hasOwnProperty(i) && (e.set(i, this[i]), delete this[i]);
    e.size > 0 && (this._$Ep = e);
  }
  createRenderRoot() {
    const e = this.shadowRoot ?? this.attachShadow(this.constructor.shadowRootOptions);
    return zt(e, this.constructor.elementStyles), e;
  }
  connectedCallback() {
    var e;
    this.renderRoot ?? (this.renderRoot = this.createRenderRoot()), this.enableUpdating(!0), (e = this._$EO) == null || e.forEach((t) => {
      var i;
      return (i = t.hostConnected) == null ? void 0 : i.call(t);
    });
  }
  enableUpdating(e) {
  }
  disconnectedCallback() {
    var e;
    (e = this._$EO) == null || e.forEach((t) => {
      var i;
      return (i = t.hostDisconnected) == null ? void 0 : i.call(t);
    });
  }
  attributeChangedCallback(e, t, i) {
    this._$AK(e, i);
  }
  _$ET(e, t) {
    var r;
    const i = this.constructor.elementProperties.get(e), o = this.constructor._$Eu(e, i);
    if (o !== void 0 && i.reflect === !0) {
      const n = (((r = i.converter) == null ? void 0 : r.toAttribute) !== void 0 ? i.converter : ae).toAttribute(t, i.type);
      this._$Em = e, n == null ? this.removeAttribute(o) : this.setAttribute(o, n), this._$Em = null;
    }
  }
  _$AK(e, t) {
    var r, n;
    const i = this.constructor, o = i._$Eh.get(e);
    if (o !== void 0 && this._$Em !== o) {
      const l = i.getPropertyOptions(o), d = typeof l.converter == "function" ? { fromAttribute: l.converter } : ((r = l.converter) == null ? void 0 : r.fromAttribute) !== void 0 ? l.converter : ae;
      this._$Em = o;
      const c = d.fromAttribute(t, l.type);
      this[o] = c ?? ((n = this._$Ej) == null ? void 0 : n.get(o)) ?? c, this._$Em = null;
    }
  }
  requestUpdate(e, t, i, o = !1, r) {
    var n;
    if (e !== void 0) {
      const l = this.constructor;
      if (o === !1 && (r = this[e]), i ?? (i = l.getPropertyOptions(e)), !((i.hasChanged ?? we)(r, t) || i.useDefault && i.reflect && r === ((n = this._$Ej) == null ? void 0 : n.get(e)) && !this.hasAttribute(l._$Eu(e, i)))) return;
      this.C(e, t, i);
    }
    this.isUpdatePending === !1 && (this._$ES = this._$EP());
  }
  C(e, t, { useDefault: i, reflect: o, wrapped: r }, n) {
    i && !(this._$Ej ?? (this._$Ej = /* @__PURE__ */ new Map())).has(e) && (this._$Ej.set(e, n ?? t ?? this[e]), r !== !0 || n !== void 0) || (this._$AL.has(e) || (this.hasUpdated || i || (t = void 0), this._$AL.set(e, t)), o === !0 && this._$Em !== e && (this._$Eq ?? (this._$Eq = /* @__PURE__ */ new Set())).add(e));
  }
  async _$EP() {
    this.isUpdatePending = !0;
    try {
      await this._$ES;
    } catch (t) {
      Promise.reject(t);
    }
    const e = this.scheduleUpdate();
    return e != null && await e, !this.isUpdatePending;
  }
  scheduleUpdate() {
    return this.performUpdate();
  }
  performUpdate() {
    var i;
    if (!this.isUpdatePending) return;
    if (!this.hasUpdated) {
      if (this.renderRoot ?? (this.renderRoot = this.createRenderRoot()), this._$Ep) {
        for (const [r, n] of this._$Ep) this[r] = n;
        this._$Ep = void 0;
      }
      const o = this.constructor.elementProperties;
      if (o.size > 0) for (const [r, n] of o) {
        const { wrapped: l } = n, d = this[r];
        l !== !0 || this._$AL.has(r) || d === void 0 || this.C(r, void 0, n, d);
      }
    }
    let e = !1;
    const t = this._$AL;
    try {
      e = this.shouldUpdate(t), e ? (this.willUpdate(t), (i = this._$EO) == null || i.forEach((o) => {
        var r;
        return (r = o.hostUpdate) == null ? void 0 : r.call(o);
      }), this.update(t)) : this._$EM();
    } catch (o) {
      throw e = !1, this._$EM(), o;
    }
    e && this._$AE(t);
  }
  willUpdate(e) {
  }
  _$AE(e) {
    var t;
    (t = this._$EO) == null || t.forEach((i) => {
      var o;
      return (o = i.hostUpdated) == null ? void 0 : o.call(i);
    }), this.hasUpdated || (this.hasUpdated = !0, this.firstUpdated(e)), this.updated(e);
  }
  _$EM() {
    this._$AL = /* @__PURE__ */ new Map(), this.isUpdatePending = !1;
  }
  get updateComplete() {
    return this.getUpdateComplete();
  }
  getUpdateComplete() {
    return this._$ES;
  }
  shouldUpdate(e) {
    return !0;
  }
  update(e) {
    this._$Eq && (this._$Eq = this._$Eq.forEach((t) => this._$ET(t, this[t]))), this._$EM();
  }
  updated(e) {
  }
  firstUpdated(e) {
  }
};
F.elementStyles = [], F.shadowRootOptions = { mode: "open" }, F[Q("elementProperties")] = /* @__PURE__ */ new Map(), F[Q("finalized")] = /* @__PURE__ */ new Map(), de == null || de({ ReactiveElement: F }), (C.reactiveElementVersions ?? (C.reactiveElementVersions = [])).push("2.1.2");
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const X = globalThis, Me = (a) => a, re = X.trustedTypes, Ve = re ? re.createPolicy("lit-html", { createHTML: (a) => a }) : void 0, rt = "$lit$", V = `lit$${Math.random().toFixed(9).slice(2)}$`, nt = "?" + V, Ht = `<${nt}>`, I = document, ee = () => I.createComment(""), te = (a) => a === null || typeof a != "object" && typeof a != "function", $e = Array.isArray, Lt = (a) => $e(a) || typeof (a == null ? void 0 : a[Symbol.iterator]) == "function", ce = `[ 	
\f\r]`, q = /<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g, Ce = /-->/g, He = />/g, H = RegExp(`>|${ce}(?:([^\\s"'>=/]+)(${ce}*=${ce}*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`, "g"), Le = /'/g, Oe = /"/g, st = /^(?:script|style|textarea|title)$/i, Ot = (a) => (e, ...t) => ({ _$litType$: a, strings: e, values: t }), s = Ot(1), Y = Symbol.for("lit-noChange"), u = Symbol.for("lit-nothing"), Pe = /* @__PURE__ */ new WeakMap(), O = I.createTreeWalker(I, 129);
function lt(a, e) {
  if (!$e(a) || !a.hasOwnProperty("raw")) throw Error("invalid template strings array");
  return Ve !== void 0 ? Ve.createHTML(e) : e;
}
const Pt = (a, e) => {
  const t = a.length - 1, i = [];
  let o, r = e === 2 ? "<svg>" : e === 3 ? "<math>" : "", n = q;
  for (let l = 0; l < t; l++) {
    const d = a[l];
    let c, h, _ = -1, m = 0;
    for (; m < d.length && (n.lastIndex = m, h = n.exec(d), h !== null); ) m = n.lastIndex, n === q ? h[1] === "!--" ? n = Ce : h[1] !== void 0 ? n = He : h[2] !== void 0 ? (st.test(h[2]) && (o = RegExp("</" + h[2], "g")), n = H) : h[3] !== void 0 && (n = H) : n === H ? h[0] === ">" ? (n = o ?? q, _ = -1) : h[1] === void 0 ? _ = -2 : (_ = n.lastIndex - h[2].length, c = h[1], n = h[3] === void 0 ? H : h[3] === '"' ? Oe : Le) : n === Oe || n === Le ? n = H : n === Ce || n === He ? n = q : (n = H, o = void 0);
    const b = n === H && a[l + 1].startsWith("/>") ? " " : "";
    r += n === q ? d + Ht : _ >= 0 ? (i.push(c), d.slice(0, _) + rt + d.slice(_) + V + b) : d + V + (_ === -2 ? l : b);
  }
  return [lt(a, r + (a[t] || "<?>") + (e === 2 ? "</svg>" : e === 3 ? "</math>" : "")), i];
};
class ie {
  constructor({ strings: e, _$litType$: t }, i) {
    let o;
    this.parts = [];
    let r = 0, n = 0;
    const l = e.length - 1, d = this.parts, [c, h] = Pt(e, t);
    if (this.el = ie.createElement(c, i), O.currentNode = this.el.content, t === 2 || t === 3) {
      const _ = this.el.content.firstChild;
      _.replaceWith(..._.childNodes);
    }
    for (; (o = O.nextNode()) !== null && d.length < l; ) {
      if (o.nodeType === 1) {
        if (o.hasAttributes()) for (const _ of o.getAttributeNames()) if (_.endsWith(rt)) {
          const m = h[n++], b = o.getAttribute(_).split(V), N = /([.?@])?(.*)/.exec(m);
          d.push({ type: 1, index: r, name: N[2], strings: b, ctor: N[1] === "." ? Tt : N[1] === "?" ? Nt : N[1] === "@" ? Rt : le }), o.removeAttribute(_);
        } else _.startsWith(V) && (d.push({ type: 6, index: r }), o.removeAttribute(_));
        if (st.test(o.tagName)) {
          const _ = o.textContent.split(V), m = _.length - 1;
          if (m > 0) {
            o.textContent = re ? re.emptyScript : "";
            for (let b = 0; b < m; b++) o.append(_[b], ee()), O.nextNode(), d.push({ type: 2, index: ++r });
            o.append(_[m], ee());
          }
        }
      } else if (o.nodeType === 8) if (o.data === nt) d.push({ type: 2, index: r });
      else {
        let _ = -1;
        for (; (_ = o.data.indexOf(V, _ + 1)) !== -1; ) d.push({ type: 7, index: r }), _ += V.length - 1;
      }
      r++;
    }
  }
  static createElement(e, t) {
    const i = I.createElement("template");
    return i.innerHTML = e, i;
  }
}
function U(a, e, t = a, i) {
  var n, l;
  if (e === Y) return e;
  let o = i !== void 0 ? (n = t._$Co) == null ? void 0 : n[i] : t._$Cl;
  const r = te(e) ? void 0 : e._$litDirective$;
  return (o == null ? void 0 : o.constructor) !== r && ((l = o == null ? void 0 : o._$AO) == null || l.call(o, !1), r === void 0 ? o = void 0 : (o = new r(a), o._$AT(a, t, i)), i !== void 0 ? (t._$Co ?? (t._$Co = []))[i] = o : t._$Cl = o), o !== void 0 && (e = U(a, o._$AS(a, e.values), o, i)), e;
}
class It {
  constructor(e, t) {
    this._$AV = [], this._$AN = void 0, this._$AD = e, this._$AM = t;
  }
  get parentNode() {
    return this._$AM.parentNode;
  }
  get _$AU() {
    return this._$AM._$AU;
  }
  u(e) {
    const { el: { content: t }, parts: i } = this._$AD, o = ((e == null ? void 0 : e.creationScope) ?? I).importNode(t, !0);
    O.currentNode = o;
    let r = O.nextNode(), n = 0, l = 0, d = i[0];
    for (; d !== void 0; ) {
      if (n === d.index) {
        let c;
        d.type === 2 ? c = new K(r, r.nextSibling, this, e) : d.type === 1 ? c = new d.ctor(r, d.name, d.strings, this, e) : d.type === 6 && (c = new Ft(r, this, e)), this._$AV.push(c), d = i[++l];
      }
      n !== (d == null ? void 0 : d.index) && (r = O.nextNode(), n++);
    }
    return O.currentNode = I, o;
  }
  p(e) {
    let t = 0;
    for (const i of this._$AV) i !== void 0 && (i.strings !== void 0 ? (i._$AI(e, i, t), t += i.strings.length - 2) : i._$AI(e[t])), t++;
  }
}
class K {
  get _$AU() {
    var e;
    return ((e = this._$AM) == null ? void 0 : e._$AU) ?? this._$Cv;
  }
  constructor(e, t, i, o) {
    this.type = 2, this._$AH = u, this._$AN = void 0, this._$AA = e, this._$AB = t, this._$AM = i, this.options = o, this._$Cv = (o == null ? void 0 : o.isConnected) ?? !0;
  }
  get parentNode() {
    let e = this._$AA.parentNode;
    const t = this._$AM;
    return t !== void 0 && (e == null ? void 0 : e.nodeType) === 11 && (e = t.parentNode), e;
  }
  get startNode() {
    return this._$AA;
  }
  get endNode() {
    return this._$AB;
  }
  _$AI(e, t = this) {
    e = U(this, e, t), te(e) ? e === u || e == null || e === "" ? (this._$AH !== u && this._$AR(), this._$AH = u) : e !== this._$AH && e !== Y && this._(e) : e._$litType$ !== void 0 ? this.$(e) : e.nodeType !== void 0 ? this.T(e) : Lt(e) ? this.k(e) : this._(e);
  }
  O(e) {
    return this._$AA.parentNode.insertBefore(e, this._$AB);
  }
  T(e) {
    this._$AH !== e && (this._$AR(), this._$AH = this.O(e));
  }
  _(e) {
    this._$AH !== u && te(this._$AH) ? this._$AA.nextSibling.data = e : this.T(I.createTextNode(e)), this._$AH = e;
  }
  $(e) {
    var r;
    const { values: t, _$litType$: i } = e, o = typeof i == "number" ? this._$AC(e) : (i.el === void 0 && (i.el = ie.createElement(lt(i.h, i.h[0]), this.options)), i);
    if (((r = this._$AH) == null ? void 0 : r._$AD) === o) this._$AH.p(t);
    else {
      const n = new It(o, this), l = n.u(this.options);
      n.p(t), this.T(l), this._$AH = n;
    }
  }
  _$AC(e) {
    let t = Pe.get(e.strings);
    return t === void 0 && Pe.set(e.strings, t = new ie(e)), t;
  }
  k(e) {
    $e(this._$AH) || (this._$AH = [], this._$AR());
    const t = this._$AH;
    let i, o = 0;
    for (const r of e) o === t.length ? t.push(i = new K(this.O(ee()), this.O(ee()), this, this.options)) : i = t[o], i._$AI(r), o++;
    o < t.length && (this._$AR(i && i._$AB.nextSibling, o), t.length = o);
  }
  _$AR(e = this._$AA.nextSibling, t) {
    var i;
    for ((i = this._$AP) == null ? void 0 : i.call(this, !1, !0, t); e !== this._$AB; ) {
      const o = Me(e).nextSibling;
      Me(e).remove(), e = o;
    }
  }
  setConnected(e) {
    var t;
    this._$AM === void 0 && (this._$Cv = e, (t = this._$AP) == null || t.call(this, e));
  }
}
class le {
  get tagName() {
    return this.element.tagName;
  }
  get _$AU() {
    return this._$AM._$AU;
  }
  constructor(e, t, i, o, r) {
    this.type = 1, this._$AH = u, this._$AN = void 0, this.element = e, this.name = t, this._$AM = o, this.options = r, i.length > 2 || i[0] !== "" || i[1] !== "" ? (this._$AH = Array(i.length - 1).fill(new String()), this.strings = i) : this._$AH = u;
  }
  _$AI(e, t = this, i, o) {
    const r = this.strings;
    let n = !1;
    if (r === void 0) e = U(this, e, t, 0), n = !te(e) || e !== this._$AH && e !== Y, n && (this._$AH = e);
    else {
      const l = e;
      let d, c;
      for (e = r[0], d = 0; d < r.length - 1; d++) c = U(this, l[i + d], t, d), c === Y && (c = this._$AH[d]), n || (n = !te(c) || c !== this._$AH[d]), c === u ? e = u : e !== u && (e += (c ?? "") + r[d + 1]), this._$AH[d] = c;
    }
    n && !o && this.j(e);
  }
  j(e) {
    e === u ? this.element.removeAttribute(this.name) : this.element.setAttribute(this.name, e ?? "");
  }
}
class Tt extends le {
  constructor() {
    super(...arguments), this.type = 3;
  }
  j(e) {
    this.element[this.name] = e === u ? void 0 : e;
  }
}
class Nt extends le {
  constructor() {
    super(...arguments), this.type = 4;
  }
  j(e) {
    this.element.toggleAttribute(this.name, !!e && e !== u);
  }
}
class Rt extends le {
  constructor(e, t, i, o, r) {
    super(e, t, i, o, r), this.type = 5;
  }
  _$AI(e, t = this) {
    if ((e = U(this, e, t, 0) ?? u) === Y) return;
    const i = this._$AH, o = e === u && i !== u || e.capture !== i.capture || e.once !== i.once || e.passive !== i.passive, r = e !== u && (i === u || o);
    o && this.element.removeEventListener(this.name, this, i), r && this.element.addEventListener(this.name, this, e), this._$AH = e;
  }
  handleEvent(e) {
    var t;
    typeof this._$AH == "function" ? this._$AH.call(((t = this.options) == null ? void 0 : t.host) ?? this.element, e) : this._$AH.handleEvent(e);
  }
}
class Ft {
  constructor(e, t, i) {
    this.element = e, this.type = 6, this._$AN = void 0, this._$AM = t, this.options = i;
  }
  get _$AU() {
    return this._$AM._$AU;
  }
  _$AI(e) {
    U(this, e);
  }
}
const Dt = { I: K }, pe = X.litHtmlPolyfillSupport;
pe == null || pe(ie, K), (X.litHtmlVersions ?? (X.litHtmlVersions = [])).push("3.3.2");
const dt = (a, e, t) => {
  const i = (t == null ? void 0 : t.renderBefore) ?? e;
  let o = i._$litPart$;
  if (o === void 0) {
    const r = (t == null ? void 0 : t.renderBefore) ?? null;
    i._$litPart$ = o = new K(e.insertBefore(ee(), r), r, void 0, t ?? {});
  }
  return o._$AI(a), o;
};
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const P = globalThis;
let D = class extends F {
  constructor() {
    super(...arguments), this.renderOptions = { host: this }, this._$Do = void 0;
  }
  createRenderRoot() {
    var t;
    const e = super.createRenderRoot();
    return (t = this.renderOptions).renderBefore ?? (t.renderBefore = e.firstChild), e;
  }
  update(e) {
    const t = this.render();
    this.hasUpdated || (this.renderOptions.isConnected = this.isConnected), super.update(e), this._$Do = dt(t, this.renderRoot, this.renderOptions);
  }
  connectedCallback() {
    var e;
    super.connectedCallback(), (e = this._$Do) == null || e.setConnected(!0);
  }
  disconnectedCallback() {
    var e;
    super.disconnectedCallback(), (e = this._$Do) == null || e.setConnected(!1);
  }
  render() {
    return Y;
  }
};
var it;
D._$litElement$ = !0, D.finalized = !0, (it = P.litElementHydrateSupport) == null || it.call(P, { LitElement: D });
const _e = P.litElementPolyfillSupport;
_e == null || _e({ LitElement: D });
(P.litElementVersions ?? (P.litElementVersions = [])).push("4.2.2");
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const Yt = (a) => (...e) => ({ _$litDirective$: a, values: e });
let Ut = class {
  constructor(e) {
  }
  get _$AU() {
    return this._$AM._$AU;
  }
  _$AT(e, t, i) {
    this._$Ct = e, this._$AM = t, this._$Ci = i;
  }
  _$AS(e, t) {
    return this.update(e, t);
  }
  update(e, t) {
    return this.render(...t);
  }
};
/**
 * @license
 * Copyright 2020 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const { I: Kt } = Dt, Ie = (a) => a, Te = (a, e) => (a == null ? void 0 : a._$litType$) !== void 0, Wt = (a) => {
  var e;
  return ((e = a == null ? void 0 : a._$litType$) == null ? void 0 : e.h) != null;
}, Ne = () => document.createComment(""), Re = (a, e, t) => {
  var r;
  const i = a._$AA.parentNode, o = a._$AB;
  if (t === void 0) {
    const n = i.insertBefore(Ne(), o), l = i.insertBefore(Ne(), o);
    t = new Kt(n, l, a, a.options);
  } else {
    const n = t._$AB.nextSibling, l = t._$AM, d = l !== a;
    if (d) {
      let c;
      (r = t._$AQ) == null || r.call(t, a), t._$AM = a, t._$AP !== void 0 && (c = a._$AU) !== l._$AU && t._$AP(c);
    }
    if (n !== o || d) {
      let c = t._$AA;
      for (; c !== n; ) {
        const h = Ie(c).nextSibling;
        Ie(i).insertBefore(c, o), c = h;
      }
    }
  }
  return t;
}, qt = {}, Fe = (a, e = qt) => a._$AH = e, De = (a) => a._$AH, Bt = (a) => {
  a._$AR();
};
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const Ye = (a) => Wt(a) ? a._$litType$.h : a.strings, Zt = Yt(class extends Ut {
  constructor(a) {
    super(a), this.et = /* @__PURE__ */ new WeakMap();
  }
  render(a) {
    return [a];
  }
  update(a, [e]) {
    const t = Te(this.it) ? Ye(this.it) : null, i = Te(e) ? Ye(e) : null;
    if (t !== null && (i === null || t !== i)) {
      const o = De(a).pop();
      let r = this.et.get(t);
      if (r === void 0) {
        const n = document.createDocumentFragment();
        r = dt(u, n), r.setConnected(!1), this.et.set(t, r);
      }
      Fe(r, [o]), Re(r, void 0, o);
    }
    if (i !== null) {
      if (t === null || t !== i) {
        const o = this.et.get(i);
        if (o !== void 0) {
          const r = De(o).pop();
          Bt(a), Re(a, void 0, r), Fe(a, [r]);
        }
      }
      this.it = e;
    } else this.it = void 0;
    return this.render(e);
  }
});
function w(a) {
  return typeof structuredClone == "function" ? structuredClone(a) : JSON.parse(JSON.stringify(a));
}
function E(a) {
  return typeof a == "object" && a !== null && !Array.isArray(a);
}
function y(a) {
  return E(a) ? a : void 0;
}
function $(a) {
  return Array.isArray(a) ? a : void 0;
}
function M(a) {
  const e = y(a);
  return e ? Object.entries(e) : [];
}
function f(a, e) {
  let t = a;
  for (const i of e) {
    if (typeof i == "number") {
      if (!Array.isArray(t))
        return;
      t = t[i];
      continue;
    }
    if (!E(t))
      return;
    t = t[i];
  }
  return t;
}
function g(a, e, t) {
  if (e.length === 0)
    return;
  let i = a;
  for (let r = 0; r < e.length - 1; r += 1) {
    const n = e[r], d = typeof e[r + 1] == "number";
    if (typeof n == "number") {
      if (!Array.isArray(i))
        return;
      let _ = i[n];
      d ? Array.isArray(_) || (_ = [], i[n] = _) : E(_) || (_ = {}, i[n] = _), i = _;
      continue;
    }
    const c = i;
    let h = c[n];
    d ? Array.isArray(h) || (h = [], c[n] = h) : E(h) || (h = {}, c[n] = h), i = h;
  }
  const o = e[e.length - 1];
  if (typeof o == "number") {
    if (!Array.isArray(i))
      return;
    i[o] = t;
    return;
  }
  i[o] = t;
}
function L(a, e) {
  e.length !== 0 && (pt(a, e), pi(a, e.slice(0, -1)));
}
function S(a, e, t) {
  const i = f(a, e), r = [...Array.isArray(i) ? i : [], t];
  g(a, e, r);
}
function Gt(a, e, t) {
  const i = f(a, e);
  if (!Array.isArray(i) || t < 0 || t >= i.length)
    return;
  const o = i.filter((r, n) => n !== t);
  if (o.length === 0) {
    L(a, e);
    return;
  }
  g(a, e, o);
}
function Jt(a, e, t, i) {
  const o = f(a, e);
  if (!Array.isArray(o) || t < 0 || i < 0 || t >= o.length || i >= o.length || t === i)
    return;
  const r = [...o], [n] = r.splice(t, 1);
  r.splice(i, 0, n), g(a, e, r);
}
function Qt(a, e, t, i) {
  const o = f(a, e);
  if (!E(o))
    return { ok: !1, reason: "target_not_available" };
  const r = i.trim();
  if (!r)
    return { ok: !1, reason: "empty_key" };
  if (r === t)
    return { ok: !0 };
  if (Object.prototype.hasOwnProperty.call(o, r))
    return { ok: !1, reason: "duplicate_key", key: r };
  if (o[t] === void 0)
    return { ok: !1, reason: "missing_key", key: t };
  const l = {};
  for (const [d, c] of Object.entries(o)) {
    if (d === t) {
      l[r] = c;
      continue;
    }
    l[d] = c;
  }
  return g(a, e, l), { ok: !0 };
}
function Xt(a) {
  return j(a, "category");
}
function ei(a) {
  return j(a, "label");
}
function ti(a, e, t) {
  return {
    kind: "ev_charger",
    id: j(a, "ev-charger"),
    name: e,
    limits: {
      max_charging_power_kw: 11
    },
    controls: {
      charge: {
        entity_id: ""
      },
      use_mode: {
        entity_id: "",
        values: {
          Fast: {
            behavior: "fixed_max_power"
          },
          ECO: {
            behavior: "surplus_aware"
          }
        }
      },
      eco_gear: {
        entity_id: "",
        values: {
          "6A": {
            min_power_kw: 1.4
          }
        }
      }
    },
    vehicles: [ct([], t)]
  };
}
function ii(a, e) {
  return {
    kind: "generic",
    id: j(a, "generic-appliance"),
    name: e,
    controls: {
      switch: {
        entity_id: ""
      }
    },
    projection: {
      strategy: "fixed",
      hourly_energy_kwh: 1
    }
  };
}
function oi(a, e) {
  return {
    kind: "climate",
    id: j(a, "climate-appliance"),
    name: e,
    controls: {
      climate: {
        entity_id: ""
      }
    },
    projection: {
      strategy: "fixed",
      hourly_energy_kwh: 1
    }
  };
}
function Ue(a) {
  return {
    id: j(a, "export-price"),
    kind: "export_price",
    enabled: !0,
    params: {
      when_price_below: 0,
      action: "stop_export"
    }
  };
}
function Ke(a, e = "") {
  return {
    id: j(a, "surplus-appliance"),
    kind: "surplus_appliance",
    enabled: !0,
    params: {
      appliance_id: e,
      action: "on",
      min_surplus_buffer_pct: 5
    }
  };
}
function ct(a, e) {
  return {
    id: j(a, "vehicle"),
    name: e,
    telemetry: {
      soc_entity_id: ""
    },
    limits: {
      battery_capacity_kwh: 64,
      max_charging_power_kw: 11
    }
  };
}
function ai() {
  return {
    behavior: "fixed_max_power"
  };
}
function ri() {
  return {
    min_power_kw: 1.4
  };
}
function ni(a) {
  return {
    energy_entity_id: "",
    label: a
  };
}
function si() {
  return {
    start: "00:00",
    end: "06:00",
    price: 1
  };
}
function li() {
  return "";
}
function di(a) {
  return j(a, "mode");
}
function ci(a) {
  return j(a, "gear");
}
function pt(a, e) {
  const t = e.slice(0, -1), i = t.length === 0 ? a : f(a, t);
  if (i === void 0)
    return;
  const o = e[e.length - 1];
  if (typeof o == "number") {
    if (!Array.isArray(i) || o < 0 || o >= i.length)
      return;
    i.splice(o, 1);
    return;
  }
  !E(i) || !(o in i) || delete i[o];
}
function pi(a, e) {
  for (let t = e.length; t > 0; t -= 1) {
    const i = e.slice(0, t), o = f(a, i), r = E(o) && Object.keys(o).length === 0, n = Array.isArray(o) && o.length === 0;
    if (!r && !n)
      break;
    pt(a, i);
  }
}
function j(a, e) {
  const t = new Set(a);
  if (!t.has(e))
    return e;
  let i = 2;
  for (; t.has(`${e}-${i}`); )
    i += 1;
  return `${e}-${i}`;
}
function ue(a, e, t) {
  const i = t.trim(), o = ui(e), r = _i(a, o), n = i.length === 0 ? null : r.find((l) => l.id === i) ?? null;
  return {
    options: r,
    selectedId: i,
    selectedOption: n,
    selectedMissingFromDraft: i.length > 0 && n === null
  };
}
function he(a, e) {
  var r, n, l;
  const t = e.trim();
  if (((r = a.selectedOption) == null ? void 0 : r.kind) !== "climate")
    return {
      visible: !1,
      disabled: !0,
      unavailable: !1,
      value: t,
      options: []
    };
  const i = a.selectedOption.liveClimateModes;
  if (!i || i.length === 0)
    return {
      visible: !0,
      disabled: !0,
      unavailable: !0,
      value: t,
      options: t.length === 0 ? [] : [{ value: t, isUnknown: !1 }]
    };
  const o = i.map((d) => ({
    value: d,
    isUnknown: !1
  }));
  return t.length > 0 && !i.includes(t) && o.unshift({ value: t, isUnknown: !0 }), {
    visible: !0,
    disabled: o.length === 1 && !((n = o[0]) != null && n.isUnknown),
    unavailable: !1,
    value: t.length > 0 ? t : ((l = o[0]) == null ? void 0 : l.value) ?? "",
    options: o
  };
}
function _i(a, e) {
  if (!a)
    return [];
  const t = $(a.appliances) ?? [], i = [];
  for (const o of t) {
    const r = y(o);
    if (!r)
      continue;
    const n = We(r.id), l = mi(r.kind);
    if (!n || !l)
      continue;
    const d = e[n];
    i.push({
      id: n,
      name: We(r.name) || n,
      kind: l,
      liveClimateModes: l === "climate" ? _t(d, l) : null,
      selectionDisabled: l === "climate" ? !hi(d, l) : !1
    });
  }
  return i;
}
function ui(a) {
  const e = Array.isArray(a == null ? void 0 : a.appliances) ? a.appliances : [], t = {};
  for (const i of e)
    gi(i) && (t[i.id] = i);
  return t;
}
function _t(a, e) {
  var i, o;
  if (!a || a.kind !== e)
    return null;
  const t = (o = (i = a.metadata) == null ? void 0 : i.scheduleCapabilities) == null ? void 0 : o.modes;
  return Array.isArray(t) ? t.filter((r) => typeof r == "string" && r.length > 0) : null;
}
function hi(a, e) {
  return (_t(a, e) ?? []).length > 0;
}
function We(a) {
  return typeof a == "string" && a.trim().length > 0 ? a.trim() : "";
}
function mi(a) {
  return a === "generic" || a === "climate" ? a : null;
}
function gi(a) {
  return !!(a && typeof a == "object" && typeof a.id == "string" && typeof a.name == "string" && typeof a.kind == "string");
}
function vi() {
  return {
    read(a) {
      return w(a);
    },
    apply(a, e) {
      return w(e);
    },
    validate(a) {
      return xe(a, "object");
    }
  };
}
function k(a, e) {
  return {
    read(t) {
      const i = a.length === 0 ? t : f(t, a);
      return w(i === void 0 ? e.emptyValue : i);
    },
    apply(t, i) {
      if (a.length === 0)
        return w(i);
      const o = w(t);
      return g(o, a, w(i)), o;
    },
    validate(t) {
      return xe(t, e.rootKind);
    }
  };
}
function B(a) {
  const e = new Map(a.map((t) => [t.yamlKey, t]));
  return {
    read(t) {
      const i = {};
      for (const o of a) {
        const r = f(t, o.documentPath);
        r !== void 0 && (i[o.yamlKey] = w(r));
      }
      return i;
    },
    apply(t, i) {
      const o = w(t), r = i;
      for (const n of a)
        L(o, n.documentPath);
      for (const n of a) {
        const l = r[n.yamlKey];
        l !== void 0 && g(o, n.documentPath, w(l));
      }
      return o;
    },
    validate(t) {
      const i = xe(t, "object");
      if (i)
        return i;
      if (!E(t))
        return { code: "expected_object" };
      for (const o of Object.keys(t))
        if (!e.has(o))
          return { code: "unexpected_key", key: o };
      return null;
    }
  };
}
function xe(a, e) {
  return e === "array" ? Array.isArray(a) ? null : { code: "expected_array" } : E(a) ? null : { code: "expected_object" };
}
const yi = {
  general: "M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.21,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.21,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.03 4.95,18.95L7.44,17.95C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.68 16.04,18.34 16.56,17.95L19.05,18.95C19.27,19.03 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z",
  power_devices: "M7,2V13H10V22L17,11H13L17,2H7Z",
  scheduler: "M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z",
  automation: "M4,7H13V9H4V7M4,11H13V13H4V11M4,15H10V17H4V15M14.94,13.5L17,17.07L19.06,13.5L17,9.93L14.94,13.5M17,7C17.34,7 17.67,7.04 18,7.09L18.41,5.11H15.59L16,7.09C16.33,7.04 16.66,7 17,7M10.25,8.66L11.92,9.65C12.28,9.13 12.72,8.69 13.24,8.33L12.25,6.66L10.25,8.66M13.24,18.67C12.72,18.31 12.28,17.87 11.92,17.35L10.25,18.34L12.25,20.34L13.24,18.67M17,20C16.66,20 16.33,19.96 16,19.91L15.59,21.89H18.41L18,19.91C17.67,19.96 17.34,20 17,20M20.76,18.67L21.75,20.34L23.75,18.34L22.08,17.35C21.72,17.87 21.28,18.31 20.76,18.67M20.76,8.33C21.28,8.69 21.72,9.13 22.08,9.65L23.75,8.66L21.75,6.66L20.76,8.33Z",
  appliances: "M5,3H19A2,2 0 0,1 21,5V19A2,2 0 0,1 19,21H5A2,2 0 0,1 3,19V5A2,2 0 0,1 5,3M7,7V9H17V7H7M7,11V13H17V11H7M7,15V17H14V15H7Z"
}, bi = {
  "section:general.core_labels_and_history": "M14,17H7V15H14M17,13H7V11H17M17,9H7V7H17M19,3H5C3.89,3 3,3.89 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5C21,3.89 20.1,3 19,3Z",
  "section:general.device_label_text": "M5.5,7A1.5,1.5 0 0,1 4,5.5A1.5,1.5 0 0,1 5.5,4A1.5,1.5 0 0,1 7,5.5A1.5,1.5 0 0,1 5.5,7M21.41,11.58L12.41,2.58C12.05,2.22 11.55,2 11,2H4C2.89,2 2,2.89 2,4V11C2,11.55 2.22,12.05 2.59,12.41L11.58,21.41C11.95,21.77 12.45,22 13,22C13.55,22 14.05,21.77 14.41,21.41L21.41,14.41C21.77,14.05 22,13.55 22,13C22,12.44 21.77,11.94 21.41,11.58Z",
  "section:power_devices.house": "M10,20V14H14V20H19V12H22L12,3L2,12H5V20H10Z",
  "section:power_devices.solar": "M12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,2L14.39,5.42C13.65,5.15 12.84,5 12,5C11.16,5 10.35,5.15 9.61,5.42L12,2M3.34,7L7.5,6.65C6.9,7.16 6.36,7.78 5.94,8.5C5.5,9.24 5.25,10 5.11,10.79L3.34,7M3.36,17L5.12,13.23C5.26,14 5.5,14.77 5.95,15.5C6.37,16.24 6.91,16.86 7.5,17.37L3.36,17M20.65,7L18.88,10.79C18.74,10 18.5,9.23 18.06,8.5C17.64,7.78 17.1,7.15 16.5,6.64L20.65,7M20.64,17L16.5,17.36C17.09,16.85 17.63,16.22 18.05,15.5C18.5,14.75 18.73,14 18.87,13.21L20.64,17M12,22L9.59,18.56C10.33,18.83 11.14,19 12,19C12.82,19 13.63,18.83 14.37,18.56L12,22Z",
  "section:power_devices.solar.bias_correction": "M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M10,16.5H14V18H10V16.5M10,11H14V15H10V11M12,5.5A1.5,1.5 0 0,1 13.5,7A1.5,1.5 0 0,1 12,8.5A1.5,1.5 0 0,1 10.5,7A1.5,1.5 0 0,1 12,5.5Z",
  "section:power_devices.solar.bias_correction.slot_invalidation": "M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M10,16.5H14V18H10V16.5M10,11H14V15H10V11M12,5.5A1.5,1.5 0 0,1 13.5,7A1.5,1.5 0 0,1 12,8.5A1.5,1.5 0 0,1 10.5,7A1.5,1.5 0 0,1 12,5.5Z",
  "section:power_devices.solar.general": "M14,17H7V15H14M17,13H7V11H17M17,9H7V7H17M19,3H5C3.89,3 3,3.89 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5C21,3.89 20.1,3 19,3Z",
  "section:power_devices.solar.forecast": "M16,11.78L20.24,4.45L21.97,5.45L16.74,14.5L10.23,10.27L5.46,19H22V21H2V3H4V17.54L9.5,8L16,11.78Z",
  "section:power_devices.solar.forecast.general": "M14,17H7V15H14M17,13H7V11H17M17,9H7V7H17M19,3H5C3.89,3 3,3.89 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5C21,3.89 20.1,3 19,3Z",
  "section:power_devices.solar.bias_correction.config": "M5,14V3H3V14H5M5,21V16H3V21H5M11,21V10H9V21H11M11,8V3H9V8H11M17,21V14H15V21H17M17,12V3H15V12H17Z",
  "section:power_devices.battery": "M15.67,4H14V2H10V4H8.33C7.6,4 7,4.6 7,5.33V20.67C7,21.4 7.6,22 8.33,22H15.67C16.4,22 17,21.4 17,20.67V5.33C17,4.6 16.4,4 15.67,4M13,18H11V16H13V18M13,14H11V9H13V14Z",
  "section:power_devices.grid": "M20,14A2,2 0 0,1 22,16V20A2,2 0 0,1 20,22H4A2,2 0 0,1 2,20V16A2,2 0 0,1 4,14H11V12H9V10H11V8H9V6H11V4A2,2 0 0,1 13,4V6H15V8H13V10H15V12H13V14H20M4,16V20H20V16H4M6,17H8V19H6V17M9,17H11V19H9V17M12,17H14V19H12V17Z",
  "section:scheduler.schedule_control_mapping": "M16.53,11.06L15.47,10L10.59,14.88L8.47,12.76L7.41,13.82L10.59,17L16.53,11.06M19,3H18V1H16V3H8V1H6V3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5A2,2 0 0,0 19,3M19,19H5V9H19V19M19,7H5V5H19V7Z",
  "section:automation.settings": "M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.21,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.21,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.03 4.95,18.95L7.44,17.95C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.68 16.04,18.34 16.56,17.95L19.05,18.95C19.27,19.03 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z",
  "section:automation.optimizer_pipeline": "M4,7H20V9H4V7M4,11H20V13H4V11M4,15H14V17H4V15",
  "section:appliances.configured_appliances": "M5,3H19A2,2 0 0,1 21,5V19A2,2 0 0,1 19,21H5A2,2 0 0,1 3,19V5A2,2 0 0,1 5,3M7,7V9H17V7H7M7,11V13H12V11H7Z"
}, fi = [
  { id: "general", labelKey: "editor.tabs.general" },
  { id: "power_devices", labelKey: "editor.tabs.power_devices" },
  { id: "scheduler", labelKey: "editor.tabs.scheduler" },
  { id: "automation", labelKey: "editor.tabs.automation" },
  { id: "appliances", labelKey: "editor.tabs.appliances" }
], qe = {
  general: "general",
  power_devices: "power_devices",
  scheduler_control: "scheduler",
  automation: "automation",
  appliances: "appliances",
  root: "general"
}, z = "document", v = {
  general: "tab:general",
  power_devices: "tab:power_devices",
  scheduler: "tab:scheduler",
  automation: "tab:automation",
  appliances: "tab:appliances"
}, p = {
  general: {
    core_labels_and_history: "section:general.core_labels_and_history",
    device_label_text: "section:general.device_label_text"
  },
  power_devices: {
    house: "section:power_devices.house",
    solar: "section:power_devices.solar",
    solar_bias_correction: "section:power_devices.solar.bias_correction",
    slot_invalidation: "section:power_devices.solar.bias_correction.slot_invalidation",
    solar_general: "section:power_devices.solar.general",
    solar_forecast: "section:power_devices.solar.forecast",
    solar_forecast_general: "section:power_devices.solar.forecast.general",
    solar_bias_correction_config: "section:power_devices.solar.bias_correction.config",
    battery: "section:power_devices.battery",
    grid: "section:power_devices.grid"
  },
  scheduler: {
    schedule_control_mapping: "section:scheduler.schedule_control_mapping"
  },
  automation: {
    settings: "section:automation.settings",
    optimizer_pipeline: "section:automation.optimizer_pipeline"
  },
  appliances: {
    configured_appliances: "section:appliances.configured_appliances"
  }
}, ut = [
  "history_buckets",
  "history_bucket_duration",
  "sources_title",
  "consumers_title",
  "groups_title",
  "others_group_label",
  "power_sensor_name_cleaner_regex",
  "show_empty_groups",
  "show_others_group",
  "device_label_text"
], ki = ut.filter(
  (a) => a !== "device_label_text"
), x = {}, me = [], wi = gt(ut), $i = gt(
  ki
), xi = [
  {
    yamlKey: "enabled",
    documentPath: ["automation", "enabled"]
  }
], zi = [
  {
    yamlKey: "total_energy_entity_id",
    documentPath: ["power_devices", "solar", "forecast", "total_energy_entity_id"]
  },
  {
    yamlKey: "daily_energy_entity_ids",
    documentPath: ["power_devices", "solar", "forecast", "daily_energy_entity_ids"]
  }
], Ai = [
  { yamlKey: "enabled", documentPath: ["power_devices", "solar", "forecast", "bias_correction", "enabled"] },
  { yamlKey: "min_history_days", documentPath: ["power_devices", "solar", "forecast", "bias_correction", "min_history_days"] },
  { yamlKey: "max_training_window_days", documentPath: ["power_devices", "solar", "forecast", "bias_correction", "max_training_window_days"] },
  { yamlKey: "training_time", documentPath: ["power_devices", "solar", "forecast", "bias_correction", "training_time"] },
  { yamlKey: "min_valid_slot_days", documentPath: ["power_devices", "solar", "forecast", "bias_correction", "min_valid_slot_days"] },
  { yamlKey: "clamp_min", documentPath: ["power_devices", "solar", "forecast", "bias_correction", "clamp_min"] },
  { yamlKey: "clamp_max", documentPath: ["power_devices", "solar", "forecast", "bias_correction", "clamp_max"] },
  { yamlKey: "aggregation_method", documentPath: ["power_devices", "solar", "forecast", "bias_correction", "aggregation_method"] },
  { yamlKey: "max_interpolated_consecutive_slots", documentPath: ["power_devices", "solar", "forecast", "bias_correction", "max_interpolated_consecutive_slots"] },
  { yamlKey: "total_energy_entity_id", documentPath: ["power_devices", "solar", "forecast", "bias_correction", "total_energy_entity_id"] }
], ht = {
  [z]: {
    id: z,
    kind: "document",
    labelKey: "editor.title",
    adapter: vi()
  },
  [v.general]: {
    id: v.general,
    kind: "tab",
    parentId: z,
    tabId: "general",
    labelKey: "editor.tabs.general",
    adapter: B(wi)
  },
  [v.power_devices]: {
    id: v.power_devices,
    kind: "tab",
    parentId: z,
    tabId: "power_devices",
    labelKey: "editor.tabs.power_devices",
    adapter: k(["power_devices"], {
      emptyValue: x,
      rootKind: "object"
    })
  },
  [v.scheduler]: {
    id: v.scheduler,
    kind: "tab",
    parentId: z,
    tabId: "scheduler",
    labelKey: "editor.tabs.scheduler",
    adapter: k(["scheduler"], {
      emptyValue: x,
      rootKind: "object"
    })
  },
  [v.automation]: {
    id: v.automation,
    kind: "tab",
    parentId: z,
    tabId: "automation",
    labelKey: "editor.tabs.automation",
    adapter: k(["automation"], {
      emptyValue: x,
      rootKind: "object"
    })
  },
  [v.appliances]: {
    id: v.appliances,
    kind: "tab",
    parentId: z,
    tabId: "appliances",
    labelKey: "editor.tabs.appliances",
    adapter: k(["appliances"], {
      emptyValue: me,
      rootKind: "array"
    })
  },
  [p.general.core_labels_and_history]: {
    id: p.general.core_labels_and_history,
    kind: "section",
    parentId: v.general,
    tabId: "general",
    labelKey: "editor.sections.core_labels_and_history",
    adapter: B($i)
  },
  [p.general.device_label_text]: {
    id: p.general.device_label_text,
    kind: "section",
    parentId: v.general,
    tabId: "general",
    labelKey: "editor.sections.device_label_text",
    adapter: k(["device_label_text"], {
      emptyValue: x,
      rootKind: "object"
    })
  },
  [p.power_devices.house]: {
    id: p.power_devices.house,
    kind: "section",
    parentId: v.power_devices,
    tabId: "power_devices",
    labelKey: "editor.sections.house",
    adapter: k(["power_devices", "house"], {
      emptyValue: x,
      rootKind: "object"
    })
  },
  [p.power_devices.solar]: {
    id: p.power_devices.solar,
    kind: "section",
    parentId: v.power_devices,
    tabId: "power_devices",
    labelKey: "editor.sections.solar",
    adapter: k(["power_devices", "solar"], {
      emptyValue: x,
      rootKind: "object"
    })
  },
  [p.power_devices.solar_bias_correction]: {
    id: p.power_devices.solar_bias_correction,
    kind: "section",
    parentId: p.power_devices.solar_forecast,
    tabId: "power_devices",
    labelKey: "editor.sections.bias_correction",
    adapter: k(
      ["power_devices", "solar", "forecast", "bias_correction"],
      {
        emptyValue: x,
        rootKind: "object"
      }
    )
  },
  [p.power_devices.solar_general]: {
    id: p.power_devices.solar_general,
    kind: "section",
    parentId: p.power_devices.solar,
    tabId: "power_devices",
    labelKey: "editor.sections.solar_general",
    adapter: k(["power_devices", "solar", "entities"], {
      emptyValue: x,
      rootKind: "object"
    })
  },
  [p.power_devices.solar_forecast]: {
    id: p.power_devices.solar_forecast,
    kind: "section",
    parentId: p.power_devices.solar,
    tabId: "power_devices",
    labelKey: "editor.sections.solar_forecast",
    adapter: k(["power_devices", "solar", "forecast"], {
      emptyValue: x,
      rootKind: "object"
    })
  },
  [p.power_devices.solar_forecast_general]: {
    id: p.power_devices.solar_forecast_general,
    kind: "section",
    parentId: p.power_devices.solar_forecast,
    tabId: "power_devices",
    labelKey: "editor.sections.solar_forecast_general",
    adapter: B(zi)
  },
  [p.power_devices.solar_bias_correction_config]: {
    id: p.power_devices.solar_bias_correction_config,
    kind: "section",
    parentId: p.power_devices.solar_bias_correction,
    tabId: "power_devices",
    labelKey: "editor.sections.bias_correction_config",
    adapter: B(Ai)
  },
  [p.power_devices.slot_invalidation]: {
    id: p.power_devices.slot_invalidation,
    kind: "section",
    parentId: p.power_devices.solar_bias_correction,
    tabId: "power_devices",
    labelKey: "editor.sections.bias_correction_slot_invalidation",
    adapter: k(
      [
        "power_devices",
        "solar",
        "forecast",
        "bias_correction",
        "slot_invalidation"
      ],
      {
        emptyValue: x,
        rootKind: "object"
      }
    )
  },
  [p.power_devices.battery]: {
    id: p.power_devices.battery,
    kind: "section",
    parentId: v.power_devices,
    tabId: "power_devices",
    labelKey: "editor.sections.battery",
    adapter: k(["power_devices", "battery"], {
      emptyValue: x,
      rootKind: "object"
    })
  },
  [p.power_devices.grid]: {
    id: p.power_devices.grid,
    kind: "section",
    parentId: v.power_devices,
    tabId: "power_devices",
    labelKey: "editor.sections.grid",
    adapter: k(["power_devices", "grid"], {
      emptyValue: x,
      rootKind: "object"
    })
  },
  [p.scheduler.schedule_control_mapping]: {
    id: p.scheduler.schedule_control_mapping,
    kind: "section",
    parentId: v.scheduler,
    tabId: "scheduler",
    labelKey: "editor.sections.schedule_control_mapping",
    adapter: k(["scheduler", "control"], {
      emptyValue: x,
      rootKind: "object"
    })
  },
  [p.automation.settings]: {
    id: p.automation.settings,
    kind: "section",
    parentId: v.automation,
    tabId: "automation",
    labelKey: "editor.sections.automation_settings",
    adapter: B(xi)
  },
  [p.automation.optimizer_pipeline]: {
    id: p.automation.optimizer_pipeline,
    kind: "section",
    parentId: v.automation,
    tabId: "automation",
    labelKey: "editor.sections.optimizer_pipeline",
    adapter: k(["automation", "optimizers"], {
      emptyValue: me,
      rootKind: "array"
    })
  },
  [p.appliances.configured_appliances]: {
    id: p.appliances.configured_appliances,
    kind: "section",
    parentId: v.appliances,
    tabId: "appliances",
    labelKey: "editor.sections.configured_appliances",
    adapter: k(["appliances"], {
      emptyValue: me,
      rootKind: "array"
    })
  }
}, mt = ht, Be = ji();
function Z(a) {
  return mt[a];
}
function Ze(a) {
  const e = [], t = [...Be[a]];
  for (; t.length > 0; ) {
    const i = t.pop();
    i && (e.push(i), t.push(...Be[i]));
  }
  return e;
}
function gt(a) {
  return a.map((e) => ({
    yamlKey: e,
    documentPath: [e]
  }));
}
function ji() {
  const a = Object.fromEntries(
    Object.keys(ht).map((e) => [e, []])
  );
  for (const e of Object.values(mt))
    e.parentId && a[e.parentId].push(e.id);
  return a;
}
const vt = {
  title: "Editor konfigurace Helman",
  description: "Upravte uloženou konfiguraci integrace Helman, validujte ji v backendu a uložte ji bez ztráty nepodporovaných klíčů nebo budoucích konfiguračních větví.",
  tabs: {
    general: "Obecné",
    power_devices: "Výkonová zařízení",
    scheduler: "Plánování",
    automation: "Automatizace",
    appliances: "Spotřebiče"
  },
  actions: {
    reload_config: "Načíst uloženou konfiguraci znovu",
    validate: "Validovat",
    validating: "Validuji...",
    save_and_reload: "Uložit a restartovat",
    saving: "Ukládám...",
    add_category: "Přidat kategorii",
    add_badge_text: "Přidat text štítku",
    add_deferrable_consumer: "Přidat odložitelný spotřebič",
    add_daily_energy_entity: "Přidat entitu denní energie",
    add_import_price_window: "Přidat okno ceny importu",
    add_ev_charger: "Přidat EV nabíječku",
    add_climate_appliance: "Přidat topení/klimatizaci",
    add_generic_appliance: "Přidat obecný spotřebič",
    add_export_price_optimizer: "Přidat optimalizátor exportní ceny",
    add_surplus_appliance_optimizer: "Přidat optimalizátor přebytkového spotřebiče",
    add_vehicle: "Přidat vozidlo",
    add_use_mode: "Přidat režim použití",
    add_eco_gear: "Přidat eco gear",
    remove: "Odstranit",
    remove_category: "Odstranit kategorii",
    up: "Nahoru",
    down: "Dolů"
  },
  status: {
    loading_config: "Načítám uloženou konfiguraci...",
    unsaved_changes: "Neuložené změny",
    stored_config_loaded: "Uložená konfigurace načtena",
    last_validation_passed: "Poslední validace prošla",
    validation_stale: "Výsledek validace je zastaralý, dokud nespustíte validaci nebo uložení",
    fix_yaml_errors: "Před validací nebo uložením opravte chyby v YAML"
  },
  issues: {
    errors: "Chyby",
    warnings: "Varování"
  },
  sections: {
    core_labels_and_history: "Základní popisky a historie",
    device_label_text: "Texty štítků zařízení",
    house: "Dům",
    solar: "Solár",
    bias_correction: "Korekce zkreslení",
    battery: "Baterie",
    grid: "Síť",
    schedule_control_mapping: "Mapování ovládání plánování",
    automation_settings: "Nastavení automatizace",
    optimizer_pipeline: "Pipeline optimalizátorů",
    configured_appliances: "Nakonfigurované spotřebiče",
    identity_and_limits: "Identita a limity",
    controls: "Ovládání",
    projection: "Projekce",
    use_modes: "Režimy použití",
    eco_gears: "Eco gears",
    vehicles: "Vozidla",
    bias_correction_settings: "Nastavení korekce zkreslení",
    bias_correction_slot_invalidation: "Vyřazení slotů z trénovacích dat",
    bias_correction_status: "Stav a trénování",
    solar_general: "Obecné",
    solar_forecast: "Předpověď",
    solar_forecast_general: "Obecné",
    bias_correction_config: "Konfigurace"
  },
  notes: {
    device_label_text: "Nakonfigurujte mapy textů štítků, například místnosti nebo vlastní skupiny štítků. Neznámé kategorie a položky se zachovají.",
    battery_entities: "Remaining energy, capacity, min SoC a max SoC fungují jako jedna skupina bateriových entit. Pokud zapnete predikci baterie, nastavte je společně.",
    grid_import_windows: "Okna cen importu musí pokrývat celý den bez mezer nebo překryvů.",
    automation: "Vizuální režim podporuje hlavní přepínač automatizace i optimalizátory export_price a surplus_appliance. Když větev automation v konfiguraci chybí, panel ji zobrazuje jako vypnutou, dokud ji nezapnete.",
    optimizer_pipeline: "Tady nastavíte seřazený seznam optimalizátorů. Optimalizátory běží v pořadí, runtime mezi kroky znovu sestavuje snapshot a neznámé budoucí klíče i druhy optimalizátorů se zachovají přesně tak, jak jsou uložené, takže je pořád můžete upravit v YAML.",
    appliances: "Editace EV nabíječky, topení/klimatizace a obecného spotřebiče je podporovaná přímo. Nepodporované budoucí typy spotřebičů se zachovají a zobrazí jen pro čtení, dokud je neodstraníte.",
    generic_appliance_projection: "Nastavte pevnou průměrnou hodinovou energii v kWh. Když je vybraná historická průměrná hodnota, Helman odhadne průměrnou hodinovou energii během zapnutého přepínače a při nedostatečné historii použije pevnou hodnotu.",
    climate_appliance_projection: "Nastavte pevnou průměrnou hodinovou energii v kWh. Když je vybraná historická průměrná hodnota, Helman odhadne průměrnou hodinovou energii během aktivního vytápění nebo chlazení a při nedostatečné historii použije pevnou hodnotu."
  },
  empty: {
    no_automation_optimizers: "Zatím nejsou nakonfigurovány žádné optimalizátory.",
    no_appliances: "Zatím nejsou nakonfigurovány žádné spotřebiče.",
    no_device_label_categories: "Nejsou nakonfigurovány žádné kategorie textů štítků."
  },
  card: {
    category: "Kategorie",
    badge_text_entry: "Položka textu štítku",
    house_deferrable_consumer: "Odložitelný spotřebič v predikci domu",
    daily_energy_entity: "Entita denní energie",
    import_window: "Importní okno",
    local_time_window: "Lokální časové okno",
    optimizer: "Optimalizátor",
    use_mode_mapping: "Mapování režimu použití",
    eco_gear_mapping: "Mapování eco gear"
  },
  fields: {
    history_buckets: "Počet historických bucketů",
    history_bucket_duration: "Délka bucketu historie",
    sources_title: "Název zdrojů",
    consumers_title: "Název spotřebičů",
    groups_title: "Název skupin",
    others_group_label: "Popisek skupiny Ostatní",
    power_sensor_name_cleaner_regex: "Regex pro čištění názvu power senzoru",
    show_empty_groups: "Zobrazit prázdné skupiny",
    show_others_group: "Zobrazit skupinu Ostatní",
    category_key: "Klíč kategorie",
    label_key: "Klíč štítku",
    badge_text: "Text štítku",
    house_power_entity: "Entita výkonu domu",
    power_sensor_label: "Popisek senzoru výkonu",
    power_switch_label: "Popisek přepínače výkonu",
    unmeasured_power_title: "Nadpis neměřeného výkonu",
    forecast_total_energy_entity: "Entita celkové energie pro predikci",
    min_history_days: "Minimální počet dní historie",
    training_window_days: "Počet dní trénovacího okna",
    max_training_window_days: "Max. počet dní trénovacího okna",
    energy_entity: "Entita energie",
    label: "Popisek",
    power_entity: "Entita výkonu",
    today_energy_entity: "Entita dnešní energie",
    remaining_today_energy_forecast: "Predikce zbývající dnešní energie",
    remaining_energy_entity: "Entita zbývající energie",
    capacity_entity: "Entita kapacity",
    min_soc_entity: "Entita min SoC",
    max_soc_entity: "Entita max SoC",
    charge_efficiency: "Účinnost nabíjení",
    discharge_efficiency: "Účinnost vybíjení",
    max_charge_power_w: "Max. nabíjecí výkon W",
    max_discharge_power_w: "Max. vybíjecí výkon W",
    sell_price_entity: "Entita prodejní ceny",
    import_price_unit: "Jednotka ceny importu",
    start: "Začátek",
    end: "Konec",
    price: "Cena",
    mode_entity: "Entita režimu",
    normal_option: "Volba Normal",
    charge_to_target_soc_option: "Volba Nabít do cílového SoC",
    discharge_to_target_soc_option: "Volba Vybít do cílového SoC",
    stop_charging_option: "Volba Zastavit nabíjení",
    stop_discharging_option: "Volba Zastavit vybíjení",
    stop_export_option: "Volba Zastavit export",
    automation_enabled: "Povolit automatizaci",
    optimizer_id: "ID optimalizátoru",
    optimizer_enabled: "Povoleno",
    when_price_below: "Když je cena pod",
    optimizer_action: "Akce",
    appliance_id: "Spotřebič",
    climate_mode: "Režim topení/klimatizace",
    min_surplus_buffer_pct: "Min. buffer přebytku %",
    appliance_name: "Název spotřebiče",
    appliance_icon: "Ikona spotřebiče",
    kind: "Druh",
    climate_entity: "Entita topení/klimatizace",
    switch_entity: "Entita přepínače",
    projection_strategy: "Strategie projekce",
    hourly_energy_kwh: "Průměrná hodinová energie kWh",
    history_energy_entity: "Entita energie pro historii",
    history_lookback_days: "Počet dní historie",
    max_charging_power_kw: "Max. nabíjecí výkon kW",
    charge_switch_entity: "Entita přepínače nabíjení",
    use_mode_entity: "Entita režimu použití",
    eco_gear_entity: "Entita eco gear",
    mode_id: "ID režimu",
    behavior: "Chování",
    gear_id: "ID stupně",
    min_power_kw: "Min. výkon kW",
    vehicle_id: "ID vozidla",
    vehicle_name: "Název vozidla",
    soc_entity: "Entita SoC",
    charge_limit_entity: "Entita limitu nabíjení",
    battery_capacity_kwh: "Kapacita baterie kWh",
    entity_id: "ID entity",
    bias_correction_enabled: "Povolit korekci zkreslení",
    bias_correction_min_history_days: "Min. dní historie",
    bias_correction_training_time: "Čas trénování (HH:MM)",
    bias_correction_min_valid_slot_days: "Min. platných sloto-dní",
    bias_correction_clamp_min: "Min. zajistění prognózy",
    bias_correction_clamp_max: "Max. zajistění prognózy",
    bias_correction_aggregation_method: "Metoda agregace",
    bias_correction_aggregation_method_ratio_of_sums: "Poměr součtů (Ratio of Sums)",
    bias_correction_aggregation_method_trimmed_mean: "Oříznutý průměr (Trimmed Mean)",
    bias_correction_max_interpolated_consecutive_slots: "Max. po sobě jdoucích interpolovaných slotů",
    bias_correction_total_energy_entity: "Entita celkové energie",
    bias_correction_slot_invalidation_max_battery_soc_percent: "Max. SoC baterie %",
    bias_correction_slot_invalidation_export_enabled_entity_id: "Entita povolení exportu",
    bias_correction_slot_invalidation_data_glitch_max_slot_wh: "Maximum slotu při výpadku dat (Wh / 15 min)",
    bias_correction_slot_invalidation_data_glitch_min_neighbour_forecast_wh: "Minimální prognóza pro nulový slot (Wh)",
    bias_correction_slot_invalidation_data_glitch_backfill_max_minutes: "Okno doplňování při výpadku (min)"
  },
  helpers: {
    history_buckets: "Kolik bucketů historie Helman drží pro UI historii.",
    history_bucket_duration: "Délka jednoho bucketu historie v hodinách.",
    power_sensor_name_cleaner_regex: "Volitelný regex použitý při normalizaci názvů power senzorů.",
    import_price_unit: "Např.: CZK/kWh",
    mode_entity: "Helman zapisuje volby akcí plánování do této entity.",
    automation_enabled: "Zapnutí vytvoří automation: { enabled: true, optimizers: [] }. Vypnutí zachová aktuální seznam optimalizátorů pro pozdější úpravy.",
    export_price_action: "Ve fázi 5 tento optimalizátor podporuje jen akci stop_export.",
    surplus_appliance_action: "Tento optimalizátor vždy zapisuje start akci. U obecných spotřebičů je to on, u klimatických spotřebičů se režim vybírá níže.",
    surplus_appliance_id: "Vyberte nakonfigurovaný obecný nebo klimatický spotřebič z aktuálního seznamu appliances. Klimatické spotřebiče zobrazí živý výběr režimu, když jsou k dispozici runtime capabilities.",
    surplus_appliance_id_missing_from_draft: "Tento optimalizátor stále odkazuje na id spotřebiče, které už v aktuálním seznamu appliances není. Hodnota zůstává zachovaná, dokud nevyberete náhradu.",
    surplus_appliance_id_pending_reload: "Některé klimatické spotřebiče jsou zobrazené, ale zůstávají zakázané, dokud save and reload nezpřístupní jejich živě podporované režimy.",
    surplus_appliance_climate_mode: "Vyberte jeden z režimů, které zvolený klimatický spotřebič právě podporuje.",
    surplus_appliance_climate_mode_unavailable: "Živé režimy klimatizace pro tento draft spotřebič zatím nejsou dostupné. Uložte a znovu načtěte konfiguraci, aby se načetly runtime-supported režimy.",
    surplus_appliance_climate_mode_single: "Tento klimatický spotřebič aktuálně nabízí jen jeden zapisovatelný režim, proto je pole jen pro čtení.",
    surplus_appliance_climate_mode_unknown: "Uložený klimatický režim už zvolený spotřebič nepodporuje. Vyberte některý z živě podporovaných režimů a opravte ho.",
    appliance_icon: "Volitelné. Když pole necháte prázdné, metadata spotřebiče použijí výchozí energetickou ikonu.",
    history_energy_entity: "Použijte kumulativní senzor energie, který sleduje spotřebu spotřebiče.",
    bias_correction_min_history_days: "Minimální počet dní historických dat (1-365) před zahájením trénování.",
    bias_correction_max_training_window_days: "Maximální počet minulých dní, které Helman může použít pro trénování modelu korekce zkreslení solární prognózy.",
    bias_correction_training_time: "Čas dne (HH:MM v místním čase), kdy se spouští automatické trénování.",
    bias_correction_min_valid_slot_days: "Minimální počet platných historických vzorků den-slot, než může slot přispět do trénování.",
    bias_correction_max_interpolated_consecutive_slots: "Maximální délka série po sobě jdoucích vynechaných slotů, která může být doplněna interpolací. Nastavte na 0 pro vypnutí.",
    bias_correction_slot_invalidation_max_battery_soc_percent: "0-100 %. Vyřadí sloty, kdy SoC baterie dosáhne této hranice a zároveň je export zakázaný.",
    bias_correction_slot_invalidation_export_enabled_entity_id: "Booleovská entita, která říká Helmanu, zda je aktuálně povolen export do sítě.",
    bias_correction_slot_invalidation_data_glitch_max_slot_wh: "Volitelné. Energie ve slotu nad tento strop je považována za chybu rekordéru. Pokud zůstane prázdné, odvodí se ze solar.max_power × 0.25 × 1.05.",
    bias_correction_slot_invalidation_data_glitch_min_neighbour_forecast_wh: "Minimální prognóza Wh pro pravidlo nulového slotu se sousedem. Výchozí 200 Wh; 0 vypne pravidlo (3).",
    bias_correction_slot_invalidation_data_glitch_backfill_max_minutes: "Jak daleko zpět smí jít doplňovací okno z výkyvu. Výchozí 120 minut."
  },
  messages: {
    reloaded_config: "Uložená konfigurace Helman byla znovu načtena z backendu.",
    load_config_failed: "Nepodařilo se načíst uloženou konfiguraci Helman.",
    validation_passed: "Validace v backendu prošla.",
    validation_failed: "Validace vrátila chyby backendu. Zkontrolujte seznam problémů níže.",
    validate_config_failed: "Nepodařilo se validovat konfiguraci v backendu.",
    config_saved_reload_started: "Konfigurace byla uložena. Restart Helman byl spuštěn.",
    config_saved: "Konfigurace byla uložena.",
    config_saved_reload_failed: "Konfigurace byla uložena, ale restart Helman selhal.",
    save_rejected: "Uložení bylo odmítnuto, protože backendová validace našla chyby.",
    save_failed: "Nepodařilo se uložit konfiguraci Helman.",
    load_ha_form_failed: "Nepodařilo se načíst formulářové komponenty Home Assistantu.",
    load_ha_yaml_editor_failed: "Nepodařilo se načíst YAML editor Home Assistantu.",
    fix_yaml_errors_first: "Před validací nebo uložením opravte chyby v YAML.",
    fix_descendant_yaml_errors: "Před přepnutím této úrovně do YAML opravte chyby v YAML v podřízených částech.",
    enter_yaml_failed: "Nepodařilo se otevřít YAML editor pro tuto část."
  },
  confirm: {
    discard_changes: "Zahodit neuložené změny a znovu načíst uloženou konfiguraci?"
  },
  rename: {
    target_not_available: "Cílový objekt není k dispozici.",
    key_empty: "Klíč nesmí být prázdný.",
    key_exists: "Klíč {key} už existuje.",
    key_missing: "Klíč {key} neexistuje."
  },
  values: {
    fixed_max_power: "Pevný maximální výkon",
    surplus_aware: "Řízeno přebytkem",
    fixed: "Pevná hodnota",
    history_average: "Historický průměr",
    export_price: "Exportní cena",
    surplus_appliance: "Přebytkový spotřebič",
    on: "Zapnout",
    heat: "Topení",
    cool: "Chlazení",
    stop_export: "Zastavit export",
    select_appliance: "Vyberte spotřebič",
    live_modes_unavailable: "Živé režimy nejsou k dispozici",
    unknown: "neznámý",
    missing_id: "chybí id"
  },
  mode: {
    visual: "Vizuální",
    yaml: "YAML"
  },
  yaml: {
    field_label: "YAML",
    aria_label: "YAML editor pro {scope}",
    helpers: {
      document: "Upravujete celý konfigurační dokument jako YAML.",
      tab: "Upravujete jako YAML jen větev aktuální karty.",
      section: "Upravujete jako YAML jen větev této sekce."
    },
    errors: {
      fix_before_leaving: "Před návratem do vizuálního režimu opravte chyby v YAML.",
      parse_failed: "Syntaxe YAML v této části není platná.",
      non_json_value: "YAML v této části se musí převést jen na JSON-kompatibilní hodnoty.",
      expected_object: "YAML pro tuto část musí být objekt.",
      expected_array: "YAML pro tuto část musí být seznam.",
      unexpected_key: "Klíč YAML {key} není v této části podporovaný.",
      apply_failed: "Nepodařilo se promítnout YAML změny do této části."
    }
  },
  dynamic: {
    consumer: "Spotřebič {index}",
    daily_energy_entity: "Entita denní energie {index}",
    import_window: "Importní okno {index}",
    appliance: "Spotřebič {index}",
    appliance_option: "{name} ({id})",
    appliance_option_pending_reload: "{label} (zpřístupní se po save and reload)",
    optimizer: "Optimalizátor {index}",
    ev_charger: "EV nabíječka {index}",
    climate_appliance: "Topení/klimatizace {index}",
    generic_appliance: "Obecný spotřebič {index}",
    vehicle: "Vozidlo {index}",
    stale_appliance: "{id} (už není v aktuální konfiguraci)",
    stale_climate_mode: "{mode} (už není podporovaný)",
    unsupported_optimizer_kind: "Nepodporovaný typ optimalizátoru: {kind}",
    unsupported_appliance_kind: "Nepodporovaný typ spotřebiče: {kind}"
  },
  help: {
    aria_label: "Nápověda k poli",
    close: "Zavřít",
    history_buckets: "Počet historických slotů, které Helman uchovává pro graf historie v UI. Každý slot pokrývá jedno období délky bucketu. Pokud není nastaveno, použije se výchozí hodnota.",
    history_bucket_duration: "Délka jednoho bucketu historie v hodinách. Určuje rozlišení grafu historie v UI. Pokud není nastaveno, použije se výchozí hodnota.",
    power_sensor_name_cleaner_regex: "Volitelný regulární výraz použitý při normalizaci zobrazovaných názvů power senzorů v UI. Hodí se pro odstranění společných předpon nebo přípon z názvů entit.",
    house_power_entity: "Senzor okamžité spotřeby domu (W). Vyžadován pro živé sledování spotřeby na dashboardu. Bez něj nejsou data o spotřebě domu k dispozici.",
    house_forecast_total_energy_entity: "Kumulativní (stále rostoucí) senzor energie, který sleduje celkovou spotřebu elektřiny domu v kWh. Helman dotazuje jeho dlouhodobou historii z HA Recorderu pro trénování modelu předpovědi spotřeby. Bez něj je předpověď spotřeby domu zcela vypnuta.",
    house_min_history_days: "Minimální počet dní zaznamenané historie potřebný k tomu, aby byla předpověď spotřeby považována za platnou. Pokud má entita kratší historii, předpověď hlásí nedostatek dat. Výchozí hodnota je 14 dní.",
    house_training_window_days: "Kolik minulých dní Helman používá pro trénování modelu předpovědi spotřeby. Větší okno produkuje stabilnější vzory, ale reaguje pomaleji na změny v životním stylu. Výchozí hodnota je 56 dní.",
    solar_power_entity: "Senzor okamžitého výkonu solárních panelů (W). Slouží k živému sledování solární výroby na dashboardu. Volitelné — bez něj není solární výkon sledován.",
    solar_today_energy_entity: "Senzor solární energie s denním nulovým resetem (kWh vyrobeno dnes). Slouží jako záložní zdroj pro overlay skutečné dnešní solární výroby na grafu, pokud není nakonfiguována celková entita energie.",
    solar_remaining_today_energy_forecast: "Entita poskytující předpověď zbývající solární energie očekávané pro zbytek dnešního dne (kWh). Zobrazuje se na dashboardu jako indikace očekávané zbývající výroby.",
    solar_forecast_total_energy_entity: "Kumulativní senzor solární energie (kWh, stále rostoucí). Primární zdroj pro vytváření overlayu skutečné výroby na grafu solární předpovědi. Pokud není nastaveno, použije se dnešní entita energie.",
    solar_daily_energy_entity: "Entita externího poskytovatele solární předpovědi (např. Forecast.Solar), která hlásí předpovídanou denní energii v kWh. Helman tyto entity používá pro sestavení předpovědi solární výroby. Přidejte jednu entitu na zdroj předpovědi.",
    battery_power_entity: "Senzor okamžitého výkonu nabíjení/vybíjení baterie (W, kladné = nabíjení, záporné = vybíjení). Slouží k živému sledování baterie. Volitelné — bez něj není výkon baterie sledován.",
    battery_remaining_energy_entity: "Senzor hlásící aktuální zbývající energii v baterii v kWh. Spolu s entitou kapacity umožňuje výpočet stavu nabití a předpověď baterie. Součást skupiny entit baterie.",
    battery_capacity_entity: "Senzor hlásící celkovou využitelnou kapacitu baterie v kWh. Slouží k výpočtu procenta stavu nabití. Součást skupiny entit baterie.",
    battery_min_soc_entity: "Senzor nebo číselná entita hlásící minimální povolený stav nabití (%). Helman neplánuje vybíjení pod tuto úroveň. Součást skupiny entit baterie.",
    battery_max_soc_entity: "Senzor nebo číselná entita hlásící maximální povolený stav nabití (%). Helman neplánuje nabíjení nad tuto úroveň. Součást skupiny entit baterie.",
    battery_charge_efficiency: "Účinnost nabíjení baterie jako desetinné číslo mezi 0 a 1 (např. 0,95 = 95 %). Energie uložená ÷ energie odebraná ze sítě. Používá se optimalizátorem pro přesné modelování nákladů nabíjení. Výchozí hodnota je 0,95.",
    battery_discharge_efficiency: "Účinnost vybíjení baterie jako desetinné číslo mezi 0 a 1 (např. 0,95 = 95 %). Energie dodaná ÷ energie uložená. Používá se optimalizátorem pro modelování výnosů z vybíjení. Výchozí hodnota je 0,95.",
    battery_max_charge_power_w: "Maximální výkon nabíjení baterie ve wattech. Slouží k modelování rychlosti a délky nabíjení v optimalizátoru plánování. Bez tohoto nastavení optimalizátor nemůže přesně odhadnout okna nabíjení.",
    battery_max_discharge_power_w: "Maximální výkon vybíjení baterie ve wattech. Slouží k modelování rychlosti a délky vybíjení v optimalizátoru plánování. Bez tohoto nastavení optimalizátor nemůže přesně odhadnout okna vybíjení.",
    grid_power_entity: "Senzor okamžitého výkonu importu/exportu ze sítě (W, kladné = import, záporné = export). Slouží k živému sledování sítě na dashboardu. Volitelné — bez něj není výkon sítě sledován.",
    grid_sell_price_entity: "Entita poskytující aktuální výkupní cenu elektřiny do sítě. Používá ji optimalizátor baterie k vyhodnocení, zda je v daný čas výhodné dodávat energii do sítě. Bez ní je výkupní cena považována za nulovou.",
    grid_import_price_unit: "Jednotka zobrazená u cen importu na dashboardu (např. CZK/kWh, EUR/kWh). Pouze kosmetická — nemá vliv na výpočty.",
    import_window_start: "Čas začátku tohoto cenového okna importu v místním čase (HH:MM). Cenová okna importu musí dohromady pokrývat celých 24 hodin bez mezer ani překryvů.",
    import_window_end: "Čas konce tohoto cenového okna importu v místním čase (HH:MM). Pro půlnoc na konci dne použijte 00:00.",
    import_window_price: "Cena elektřiny při importu v průběhu tohoto časového okna, v jednotce nakonfigurované výše. Optimalizátor baterie ji používá k nalezení nejlevnějších čas pro nabíjení.",
    scheduler_mode_entity: "Entita input_select nebo select, do které Helman zapisuje příkazy akcí plánování. Helman nastaví hodnotu volby odpovídající požadovanému režimu baterie (nabíjení, vybíjení, normální atd.). Vyžadováno pro skutečné řízení baterie plánovačem.",
    scheduler_action_option: "Hodnota volby, kterou Helman zapíše do entity režimu při naplánování této akce. Musí přesně odpovídat jedné z voleb v entitě select. Nechte prázdné, pokud vaše střídač tuto akci nepodporuje.",
    automation_optimizer_id: "Jedinečný identifikátor optimalizátoru uložený v automation.optimizers[].id. Držte ho stabilní, aby budoucí reference, logy a ladění zůstaly čitelné.",
    export_price_when_price_below: "Prahová hodnota ve stejné jednotce jako předpověď exportní ceny. Když předpovězená exportní cena klesne pod tuto hodnotu, optimalizátor vytvoří sloty stop_export tam, kde je očekávaný export.",
    export_price_action: "Ve fázi 5 je podporovaná jen akce stop_export. Další fáze mohou přidat další akce optimalizátorů, ale toto pole je zatím pevné.",
    surplus_appliance_id: "ID nakonfigurovaného spotřebiče, které tento optimalizátor smí zapisovat. Výběr je řízen aktuálním seznamem appliances v editoru, takže draft přidání i smazání se projeví hned.",
    surplus_appliance_action: "Tento optimalizátor vždy zapisuje start akci. U obecných spotřebičů je to on, zatímco u klimatických spotřebičů se používá níže zvolený klimatický režim.",
    surplus_appliance_climate_mode: "Povinné jen pro klimatické spotřebiče. Editor zobrazuje jen živě podporované režimy vrácené pro zvolený spotřebič.",
    surplus_appliance_min_surplus_buffer_pct: "Dodatečný buffer nad odběr spotřebiče vyjádřený v procentech. Každý pokrytý bucket předpovědi ve slotu musí splnit buffered surplus, než Helman slot zapíše.",
    deferrable_consumer_energy_entity: "Kumulativní senzor energie (kWh) sledující celkovou spotřebu elektřiny tohoto spotřebiče. Helman používá jeho zaznamenanou historii k odhadu, kolik energie tento spotřebič spotřebuje v nadcházejících časových slotech, aby ho mohl přesunout do levnějších period.",
    appliance_id: "Jedinečný interní identifikátor tohoto spotřebiče. Používá se v odkazech automatizací a sledování plánování. Neměňte ho po nakonfigurování spotřebiče, mohlo by to rozbít existující automatizace.",
    appliance_name: "Zobrazovaný název tohoto spotřebiče v dashboardu Helman a přehledech energie.",
    ev_max_charging_power_kw: "Maximální výkon nabíjení EV nabíječky v kW. Optimalizátor ho používá k modelování rychlosti nabíjení vozidla a plánování oken nabíjení.",
    ev_charge_switch_entity: "Entita přepínače, která fyzicky povoluje nebo zakazuje nabíjení EV. Helman ji zapíná a vypíná pro realizaci plánu nabíjení. Musí být skutečný řídicí přepínač vaší nabíječky.",
    ev_use_mode_entity: "Entita select nebo input_select, která ovládá provozní režim EV nabíječky (např. pevný maximální výkon, řízení přebytkem). Helman zapisuje aktivní režim do této entity pro realizaci naplánovaného chování nabíjení.",
    ev_eco_gear_entity: "Entita select nebo input_select, která ovládá úroveň eco gear (krok výkonu nabíjení) EV nabíječky. Helman ji řídí v režimu řízení přebytkem pro škrcení nabíjení na dostupný solární přebytek.",
    appliance_climate_entity: "Entita klimatizace pro tento spotřebič. Helman sleduje její aktivní/neaktivní stav (režim topení nebo chlazení) pro tvorbu energetických predikcí na základě historie. Vyžadováno pro strategii history_average.",
    appliance_switch_entity: "Entita přepínače, která ovládá tento obecný spotřebič. Helman sleduje historii stavů zapnuto/vypnuto pro energetické predikce při použití strategie history_average.",
    appliance_projection_strategy: "Jak Helman odhaduje budoucí spotřebu energie tohoto spotřebiče. Pevná: vždy používá nakonfigurovanou průměrnou hodinovou energii. Historický průměr: učí se ze zaznamenané historie entity a při nedostatku dat se vrátí na pevnou hodnotu.",
    appliance_hourly_energy_kwh: "Průměrná spotřeba energie za hodinu v kWh, když je spotřebič aktivní. Používá se přímo pro pevnou strategii a jako záložní hodnota pro historický průměr, pokud zaznamenaná historie nestačí.",
    appliance_history_lookback_days: "Kolik dní zpětně Helman zohledňuje při výpočtu historického průměru spotřeby energie tohoto spotřebiče. Delší lookback dává stabilnější odhady, ale reaguje pomaleji na změny ve vzorcích používání.",
    vehicle_id: "Jedinečný interní identifikátor tohoto vozidla. Používá se pro sledování cílů nabíjení a přiřazení plánování. Neměňte ho po nakonfigurování vozidla.",
    vehicle_soc_entity: "Senzor hlásící aktuální stav nabití baterie vozidla v procentech (0–100). Vyžadováno pro plánování nabíjení s ohledem na vozidlo — Helman ho používá k určení, kolik nabíjení je potřeba.",
    vehicle_charge_limit_entity: "Číselná entita hlásící nakonfigurovaný limit nabíjení vozidla v procentech (0–100). Pokud je nastavena, Helman ji používá jako cílový SoC místo předpokladu 100 %. Volitelné.",
    vehicle_battery_capacity_kwh: "Celková využitelná kapacita baterie vozidla v kWh. Vyžadováno pro přesné výpočty cíle nabíjení a délky nabíjení.",
    vehicle_max_charging_power_kw: "Maximální výkon AC nabíjení tohoto vozidla v kW. Slouží k modelování rychlosti nabíjení vozidla a plánování délky oken nabíjení.",
    bias_correction_enabled: "Povolit trénování korekce zkreslení solární prognózy. Pokud je povoleno, Helman automaticky trénuje model opravy prognózy na základě vaší skutečné solární výroby.",
    bias_correction_min_history_days: "Minimální počet dní zaznamenaných solárních dat před tím, než lze model trénovat (1-365). Vyšší hodnota zajišťuje stabilnější trénování, ale zpožďuje opravy. Výchozí hodnota je 10 dní.",
    bias_correction_max_training_window_days: "Maximální počet minulých dní, které Helman může použít pro trénování modelu korekce zkreslení solární prognózy. Pokud je historie kratší, Helman použije dostupná data; pokud je delší, trénovací okno omezí na tuto hodnotu. Vyšší maximum vytváří stabilnější korekční faktory, ale reaguje pomaleji na sezónní nebo systémové změny. Výchozí hodnota je 90 dní.",
    bias_correction_training_time: "Čas dne (HH:MM v místním čase), kdy se spouští automatické trénování, obvykle během hodin s nízkou aktivitou. Trénování zpracovává historická data za účelem nepřetržitého zlepšování přesnosti prognózy.",
    bias_correction_min_valid_slot_days: "Minimální počet platných historických vzorků den-slot, které Helman vyžaduje před natrénováním korekčního faktoru pro konkrétní slot. Neplatné sloto-dny se do tohoto počtu nezapočítávají. Pokud má slot méně platných vzorků než tento práh, Helman slot z profilu vynechá a ponechá pro něj korekci na 0. Výchozí hodnota je 5 dní.",
    bias_correction_clamp_min: "Dolní mez pro korekční faktor. Zabraňuje přílišné opravě, když je skutečná výroba mnohem nižší než prognóza. Například hodnota 0,0 umožní, aby opravená prognóza klesla až na nulu během fyzického zastínění panelů. Vyšší hodnota (blíže k 1,0) snižuje intenzitu korekce. Výchozí hodnota je 0,0.",
    bias_correction_clamp_max: "Horní mez pro korekční faktor. Zabraňuje přílišné opravě, když je skutečná výroba mnohem vyšší než prognóza. Například hodnota 3,0 zajistí, že opravená prognóza bude činit maximálně 300 % původní hodnoty. Nižší hodnota (blíže k 1,0) snižuje intenzitu korekce. Výchozí hodnota je 3,0.",
    bias_correction_max_interpolated_consecutive_slots: "Maximální počet po sobě jdoucích slotů, které nesplnily podmínku min_valid_slot_days a mohou být doplněny lineární interpolací mezi nejbližšími zdravými sousedy. Sloty vynechané z jiných důvodů (např. nízká prognóza) se nikdy neinterpolují. Nastavte na 0 pro úplné vypnutí interpolace a zachování původního chování. Výchozí hodnota je 2.",
    bias_correction_aggregation_method: "Metoda použitá k agregaci historických dat. 'Poměr součtů' správně váží jasné slunečné dny oproti menším oblačným dnům a přirozeně filtruje šum z kvantizace senzoru energie (doporučeno). 'Oříznutý průměr' počítá faktor pro každý den nezávisle a průměruje je po vynechání nejvyšších a nejnižších extrémů, což poskytuje robustnost proti jednodenním anomáliím, ale může příliš korigovat velké slunečné dny kvůli nedostatku vážení objemu. Výchozí hodnota je 'Poměr součtů'.",
    bias_correction_total_energy_entity: "Kumulativní senzor solární energie (kWh, neustále se zvyšující) používaný k vytváření historie skutečné solární výroby pro trénování modelu korekce."
  }
}, yt = {
  yes: "Ano",
  no: "Ne",
  unknown: "Neznámé",
  not_available: "Není k dispozici"
}, bt = {
  status_panel: {
    subtitle: "Aktuální stav korekce zkreslení a ovládání trénování",
    loading_status: "Načítám stav...",
    unable_to_load_status: "Nepodařilo se načíst stav korekce zkreslení",
    home_assistant_not_available: "Home Assistant není k dispozici.",
    failed_to_load_status: "Nepodařilo se načíst stav.",
    training_completed: "Trénování bylo úspěšně dokončeno.",
    training_failed: "Trénování selhalo: {error}",
    unknown_error: "Neznámá chyba",
    section_status: "Stav",
    enabled: "Povoleno",
    current_status: "Aktuální stav",
    trained_at: "Natrénováno",
    next_training: "Další trénování",
    effective_variant: "Použitá varianta",
    training_days_used: "Použité dny trénování",
    training_days_required: "{used} / {required} požadováno",
    insufficient_history_text: "Zatím není k dispozici dostatek historických dat. K dispozici je {used} dní, pro trénování je potřeba alespoň {required} dní.",
    error: "Chyba",
    dropped_days: "Vynechané dny",
    actions: "Akce",
    training: "Trénuji...",
    train_now: "Trénovat teď",
    refresh_status: "Obnovit stav",
    info: "Korekce zkreslení solární prognózy upravuje přesnost solární prognózy podle vlastností vašeho systému. Zapnutím trénování se budou predikce postupně automaticky zlepšovat.",
    render_error: "Chyba vykreslení: {error}"
  },
  statuses: {
    applied: "Použito",
    profile_trained: "Profil natrénován",
    insufficient_history: "Nedostatek historie",
    config_changed_pending_retrain: "Konfigurace změněna, čeká na přetrénování",
    training_failed: "Trénování selhalo",
    not_configured: "Nenakonfigurováno",
    no_training_yet: "Zatím netrénováno"
  },
  effective_variants: {
    raw: "Surová",
    adjusted: "Upravená"
  },
  dropped_reasons: {
    day_forecast_too_low: "Denní prognóza je příliš nízká",
    day_ratio_out_of_band: "Denní poměr je mimo povolený rozsah"
  },
  error_codes: {
    training_in_progress: "Trénování už probíhá.",
    bias_correction_not_configured: "Korekce zkreslení není nakonfigurovaná.",
    internal_error: "Neočekávané selhání trénování solární korekce.",
    no_profile: "Profil solární korekce není k dispozici.",
    not_loaded: "Služba korekce solární prognózy Helman není k dispozici.",
    unauthorized: "Je vyžadován administrátorský přístup."
  }
}, Si = {
  editor: vt,
  common: yt,
  bias_correction: bt
}, Ei = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  bias_correction: bt,
  common: yt,
  default: Si,
  editor: vt
}, Symbol.toStringTag, { value: "Module" })), ft = {
  title: "Helman config editor",
  description: "Edit the stored Helman integration config, validate it in the backend, and save it without losing unsupported keys or future config branches.",
  tabs: {
    general: "General",
    power_devices: "Power devices",
    scheduler: "Scheduler",
    automation: "Automation",
    appliances: "Appliances"
  },
  actions: {
    reload_config: "Reload stored config",
    validate: "Validate",
    validating: "Validating...",
    save_and_reload: "Save and reload",
    saving: "Saving...",
    add_category: "Add category",
    add_badge_text: "Add badge text",
    add_deferrable_consumer: "Add deferrable consumer",
    add_daily_energy_entity: "Add daily energy entity",
    add_import_price_window: "Add import price window",
    add_ev_charger: "Add EV charger",
    add_climate_appliance: "Add climate appliance",
    add_generic_appliance: "Add generic appliance",
    add_export_price_optimizer: "Add export price optimizer",
    add_surplus_appliance_optimizer: "Add surplus appliance optimizer",
    add_vehicle: "Add vehicle",
    add_use_mode: "Add use mode",
    add_eco_gear: "Add eco gear",
    remove: "Remove",
    remove_category: "Remove category",
    up: "Up",
    down: "Down"
  },
  status: {
    loading_config: "Loading stored config...",
    unsaved_changes: "Unsaved changes",
    stored_config_loaded: "Stored config loaded",
    last_validation_passed: "Last validation passed",
    validation_stale: "Validation results are stale until you validate or save",
    fix_yaml_errors: "Fix YAML errors before validating or saving"
  },
  issues: {
    errors: "Errors",
    warnings: "Warnings"
  },
  sections: {
    core_labels_and_history: "Core labels and history",
    device_label_text: "Device label text",
    house: "House",
    solar: "Solar",
    bias_correction: "Bias Correction",
    battery: "Battery",
    grid: "Grid",
    schedule_control_mapping: "Schedule control mapping",
    automation_settings: "Automation settings",
    optimizer_pipeline: "Optimizer pipeline",
    configured_appliances: "Configured appliances",
    identity_and_limits: "Identity and limits",
    controls: "Controls",
    projection: "Projection",
    use_modes: "Use modes",
    eco_gears: "Eco gears",
    vehicles: "Vehicles",
    bias_correction_settings: "Bias correction settings",
    bias_correction_slot_invalidation: "Invalidate training slot data",
    bias_correction_status: "Status and training",
    solar_general: "General",
    solar_forecast: "Forecast",
    solar_forecast_general: "General",
    bias_correction_config: "Configuration"
  },
  notes: {
    device_label_text: "Configure badge text maps such as rooms or custom label groups. Unknown categories and entries are preserved.",
    battery_entities: "Remaining energy, capacity, min SoC, and max SoC work as one battery entity group. Configure them together when battery forecasting is enabled.",
    grid_import_windows: "Import price windows must cover the whole day without gaps or overlaps.",
    automation: "Visual mode supports the automation enable switch plus the export_price and surplus_appliance optimizers. When the automation branch is missing, the panel shows automation as disabled until you turn it on.",
    optimizer_pipeline: "Configure the ordered optimizer list here. Optimizers run in order, the runtime rebuilds the snapshot between steps, and unknown future optimizer keys and kinds are preserved exactly as stored so they can still be edited in YAML.",
    appliances: "EV charger, climate appliance, and generic appliance editing are supported directly. Unsupported future appliance kinds are preserved and shown read-only unless you remove them.",
    generic_appliance_projection: "Configure the fixed average hourly energy in kWh. When history average is selected, Helman estimates the average hourly energy while the switch was on and falls back to the fixed value if history is insufficient.",
    climate_appliance_projection: "Configure the fixed average hourly energy in kWh. When history average is selected, Helman estimates the average hourly energy while the climate entity was active in heat or cool mode and falls back to the fixed value if history is insufficient."
  },
  empty: {
    no_automation_optimizers: "No optimizers configured yet.",
    no_appliances: "No appliances configured yet.",
    no_device_label_categories: "No device label categories configured."
  },
  card: {
    category: "Category",
    badge_text_entry: "Badge text entry",
    house_deferrable_consumer: "House forecast deferrable consumer",
    daily_energy_entity: "Daily energy entity",
    import_window: "Import window",
    local_time_window: "Local time window",
    optimizer: "Optimizer",
    use_mode_mapping: "Use mode mapping",
    eco_gear_mapping: "Eco gear mapping"
  },
  fields: {
    history_buckets: "History buckets",
    history_bucket_duration: "History bucket duration",
    sources_title: "Sources title",
    consumers_title: "Consumers title",
    groups_title: "Groups title",
    others_group_label: "Others group label",
    power_sensor_name_cleaner_regex: "Power sensor cleaner regex",
    show_empty_groups: "Show empty groups",
    show_others_group: "Show others group",
    category_key: "Category key",
    label_key: "Label key",
    badge_text: "Badge text",
    house_power_entity: "House power entity",
    power_sensor_label: "Power sensor label",
    power_switch_label: "Power switch label",
    unmeasured_power_title: "Unmeasured power title",
    forecast_total_energy_entity: "Forecast total energy entity",
    min_history_days: "Min history days",
    training_window_days: "Training window days",
    max_training_window_days: "Max training window days",
    energy_entity: "Energy entity",
    label: "Label",
    power_entity: "Power entity",
    today_energy_entity: "Today energy entity",
    remaining_today_energy_forecast: "Remaining today energy forecast",
    remaining_energy_entity: "Remaining energy entity",
    capacity_entity: "Capacity entity",
    min_soc_entity: "Min SoC entity",
    max_soc_entity: "Max SoC entity",
    charge_efficiency: "Charge efficiency",
    discharge_efficiency: "Discharge efficiency",
    max_charge_power_w: "Max charge power W",
    max_discharge_power_w: "Max discharge power W",
    sell_price_entity: "Sell price entity",
    import_price_unit: "Import price unit",
    start: "Start",
    end: "End",
    price: "Price",
    mode_entity: "Mode entity",
    normal_option: "Normal option",
    charge_to_target_soc_option: "Charge to target SoC option",
    discharge_to_target_soc_option: "Discharge to target SoC option",
    stop_charging_option: "Stop charging option",
    stop_discharging_option: "Stop discharging option",
    stop_export_option: "Stop export option",
    automation_enabled: "Enable automation",
    optimizer_id: "Optimizer id",
    optimizer_enabled: "Enabled",
    when_price_below: "When price below",
    optimizer_action: "Action",
    appliance_id: "Appliance id",
    climate_mode: "Climate mode",
    min_surplus_buffer_pct: "Min surplus buffer %",
    appliance_name: "Appliance name",
    appliance_icon: "Appliance icon",
    kind: "Kind",
    climate_entity: "Climate entity",
    switch_entity: "Switch entity",
    projection_strategy: "Projection strategy",
    hourly_energy_kwh: "Average hourly energy kWh",
    history_energy_entity: "History energy entity",
    history_lookback_days: "History lookback days",
    max_charging_power_kw: "Max charging power kW",
    charge_switch_entity: "Charge switch entity",
    use_mode_entity: "Use mode entity",
    eco_gear_entity: "Eco gear entity",
    mode_id: "Mode id",
    behavior: "Behavior",
    gear_id: "Gear id",
    min_power_kw: "Min power kW",
    vehicle_id: "Vehicle id",
    vehicle_name: "Vehicle name",
    soc_entity: "SoC entity",
    charge_limit_entity: "Charge limit entity",
    battery_capacity_kwh: "Battery capacity kWh",
    entity_id: "Entity id",
    bias_correction_enabled: "Enable bias correction",
    bias_correction_min_history_days: "Min history days",
    bias_correction_training_time: "Training time (HH:MM)",
    bias_correction_min_valid_slot_days: "Min valid slot-days",
    bias_correction_clamp_min: "Min forecast clamp",
    bias_correction_clamp_max: "Max forecast clamp",
    bias_correction_aggregation_method: "Aggregation method",
    bias_correction_aggregation_method_ratio_of_sums: "Ratio of Sums",
    bias_correction_aggregation_method_trimmed_mean: "Trimmed Mean",
    bias_correction_max_interpolated_consecutive_slots: "Max interpolated consecutive slots",
    bias_correction_total_energy_entity: "Total energy entity",
    bias_correction_slot_invalidation_max_battery_soc_percent: "Max battery SoC %",
    bias_correction_slot_invalidation_export_enabled_entity_id: "Export enabled entity",
    bias_correction_slot_invalidation_data_glitch_max_slot_wh: "Data-glitch spike cap (Wh / 15 min)",
    bias_correction_slot_invalidation_data_glitch_min_neighbour_forecast_wh: "Data-glitch zero forecast floor (Wh)",
    bias_correction_slot_invalidation_data_glitch_backfill_max_minutes: "Data-glitch backfill window (min)"
  },
  helpers: {
    history_buckets: "How many history buckets Helman keeps for UI history.",
    history_bucket_duration: "Duration of one history bucket in hours.",
    power_sensor_name_cleaner_regex: "Optional regex applied when normalizing power sensor names.",
    import_price_unit: "Example: CZK/kWh",
    mode_entity: "Helman writes schedule action options to this entity.",
    automation_enabled: "Turning this on materializes automation: { enabled: true, optimizers: [] }. Turning it off keeps the current optimizer list for later edits.",
    export_price_action: "Phase 5 only supports the stop_export action for this optimizer.",
    surplus_appliance_action: "This optimizer always writes a start action. Generic appliances use on; climate appliances use the selected mode below.",
    surplus_appliance_id: "Pick a configured generic or climate appliance from the current appliances list. Climate appliances expose a live mode selector when runtime capabilities are available.",
    surplus_appliance_id_missing_from_draft: "This optimizer still references an appliance id that is no longer present in the current appliances list. The value is preserved until you choose a replacement.",
    surplus_appliance_id_pending_reload: "Some climate appliances are shown but disabled until save and reload makes their live supported modes available.",
    surplus_appliance_climate_mode: "Choose one of the live supported modes currently exposed by the selected climate appliance.",
    surplus_appliance_climate_mode_unavailable: "Live climate modes are not available for this draft appliance yet. Save and reload the config to load runtime-supported modes.",
    surplus_appliance_climate_mode_single: "This climate appliance currently exposes only one authorable mode, so the field is read-only.",
    surplus_appliance_climate_mode_unknown: "The stored climate mode is no longer supported by the selected appliance. Pick one of the live supported modes to repair it.",
    appliance_icon: "Optional. Leave empty to use the default energy icon in appliance metadata.",
    history_energy_entity: "Use a cumulative energy sensor that tracks the appliance energy consumption.",
    bias_correction_min_history_days: "Minimum days of historical data (1-365) before training begins.",
    bias_correction_max_training_window_days: "Maximum number of past days Helman may use to train the solar bias correction model.",
    bias_correction_training_time: "Time of day (HH:MM in local time) when automatic training runs.",
    bias_correction_min_valid_slot_days: "Minimum number of valid historical day-slot samples required before a slot can contribute to training.",
    bias_correction_max_interpolated_consecutive_slots: "Maximum run of consecutive omitted slots that can be filled by interpolation. Set to 0 to disable.",
    bias_correction_slot_invalidation_max_battery_soc_percent: "0-100%. Exclude slots when battery SoC reaches this threshold and export is disabled.",
    bias_correction_slot_invalidation_export_enabled_entity_id: "Boolean entity that tells Helman whether grid export is currently allowed.",
    bias_correction_slot_invalidation_data_glitch_max_slot_wh: "Optional. Energy in a single 15-minute slot above this cap is treated as a recorder glitch. Defaults to solar.max_power × 0.25 × 1.05 when left blank.",
    bias_correction_slot_invalidation_data_glitch_min_neighbour_forecast_wh: "Forecast Wh floor for the zero-with-neighbour rule. Default 200 Wh. Set to 0 to disable rule (3).",
    bias_correction_slot_invalidation_data_glitch_backfill_max_minutes: "How far back the spike-backfill walk may invalidate consecutive zero slots. Default 120 minutes."
  },
  messages: {
    reloaded_config: "Reloaded the stored Helman config from the backend.",
    load_config_failed: "Failed to load the stored Helman config.",
    validation_passed: "Validation passed in the backend.",
    validation_failed: "Validation returned backend errors. Review the issue list below.",
    validate_config_failed: "Failed to validate the config in the backend.",
    config_saved_reload_started: "Config saved. Helman reload started.",
    config_saved: "Config saved.",
    config_saved_reload_failed: "Config was saved, but Helman reload failed.",
    save_rejected: "Save was rejected because the backend validation found errors.",
    save_failed: "Failed to save the Helman config.",
    load_ha_form_failed: "Failed to load Home Assistant form components.",
    load_ha_yaml_editor_failed: "Failed to load the Home Assistant YAML editor.",
    fix_yaml_errors_first: "Fix the YAML errors before validating or saving.",
    fix_descendant_yaml_errors: "Fix child YAML errors before switching this scope to YAML.",
    enter_yaml_failed: "Failed to open the YAML editor for this scope."
  },
  confirm: {
    discard_changes: "Discard unsaved changes and reload the stored config?"
  },
  rename: {
    target_not_available: "Target object is not available.",
    key_empty: "Key must not be empty.",
    key_exists: "Key {key} already exists.",
    key_missing: "Key {key} does not exist."
  },
  values: {
    fixed_max_power: "Fixed max power",
    surplus_aware: "Surplus aware",
    fixed: "Fixed",
    history_average: "History average",
    export_price: "Export price",
    surplus_appliance: "Surplus appliance",
    on: "On",
    heat: "Heat",
    cool: "Cool",
    stop_export: "Stop export",
    select_appliance: "Select appliance",
    live_modes_unavailable: "Live modes unavailable",
    unknown: "unknown",
    missing_id: "missing id"
  },
  mode: {
    visual: "Visual",
    yaml: "YAML"
  },
  yaml: {
    field_label: "YAML",
    aria_label: "YAML editor for {scope}",
    helpers: {
      document: "Editing the full config document as YAML.",
      tab: "Editing only the current tab branch as YAML.",
      section: "Editing only this section branch as YAML."
    },
    errors: {
      fix_before_leaving: "Fix the YAML errors before switching back to visual mode.",
      parse_failed: "YAML syntax is invalid for this scope.",
      non_json_value: "YAML for this scope must resolve to JSON-compatible values only.",
      expected_object: "YAML for this scope must be an object.",
      expected_array: "YAML for this scope must be a list.",
      unexpected_key: "YAML key {key} is not supported in this scope.",
      apply_failed: "Failed to apply the YAML changes to this scope."
    }
  },
  dynamic: {
    consumer: "Consumer {index}",
    daily_energy_entity: "Daily energy entity {index}",
    import_window: "Import window {index}",
    appliance: "Appliance {index}",
    appliance_option: "{name} ({id})",
    appliance_option_pending_reload: "{label} (save and reload to enable)",
    optimizer: "Optimizer {index}",
    ev_charger: "EV Charger {index}",
    climate_appliance: "Climate appliance {index}",
    generic_appliance: "Generic appliance {index}",
    vehicle: "Vehicle {index}",
    stale_appliance: "{id} (no longer in current config)",
    stale_climate_mode: "{mode} (no longer supported)",
    unsupported_optimizer_kind: "Unsupported optimizer kind: {kind}",
    unsupported_appliance_kind: "Unsupported appliance kind: {kind}"
  },
  help: {
    aria_label: "Field help",
    close: "Close",
    history_buckets: "Number of history slots Helman keeps in storage for the UI history chart. Each slot covers one bucket-duration period. If not set, a built-in default is used.",
    history_bucket_duration: "Duration of a single history bucket in hours. Determines how fine-grained the UI history chart is. If not set, a built-in default is used.",
    power_sensor_name_cleaner_regex: "Optional regular expression applied when normalizing power sensor display names in the UI. Useful for stripping common prefixes or suffixes from entity names.",
    house_power_entity: "Real-time power consumption sensor for the whole house (W). Required for live power monitoring on the dashboard. Without it, house power data is not available.",
    house_forecast_total_energy_entity: "Cumulative (ever-increasing) energy sensor that tracks total house electricity consumption in kWh. Helman queries its long-term history from the HA Recorder to train the consumption forecast model. Without it, the house consumption forecast is completely disabled.",
    house_min_history_days: "Minimum number of days of recorded history required before the consumption forecast is considered valid. If the entity has fewer days of history, the forecast reports insufficient data. Defaults to 14 days if not set.",
    house_training_window_days: "How many past days Helman uses to train the consumption forecast model. A larger window produces more stable patterns but reacts more slowly to lifestyle changes. Defaults to 56 days if not set.",
    solar_power_entity: "Real-time solar panel output sensor (W). Used for live solar monitoring on the dashboard. Optional — solar power is not tracked without it.",
    solar_today_energy_entity: "Daily-resetting solar energy sensor (kWh produced today). Used as a fallback source for today's actual solar production overlay on the chart when the total energy entity is not configured.",
    solar_remaining_today_energy_forecast: "Entity that provides the forecast of remaining solar energy expected for the rest of today (kWh). Shown on the dashboard to indicate expected remaining generation.",
    solar_forecast_total_energy_entity: "Cumulative solar energy sensor (kWh, ever-increasing). Primary source for building the actual production history overlay on the solar forecast chart. Falls back to the today energy entity if not set.",
    solar_daily_energy_entity: "Entity from an external solar forecast provider (e.g. Forecast.Solar) that reports predicted daily energy in kWh. Helman uses these entities to build the solar generation forecast. Add one entity per forecast source.",
    battery_power_entity: "Real-time battery charge/discharge power sensor (W, positive = charging, negative = discharging). Used for live battery monitoring. Optional — battery power is not tracked without it.",
    battery_remaining_energy_entity: "Sensor reporting the current battery remaining energy in kWh. Together with the capacity entity, it enables battery state of charge calculation and forecast. Part of the battery entity group.",
    battery_capacity_entity: "Sensor reporting the total usable battery capacity in kWh. Used to calculate state of charge percentage. Part of the battery entity group.",
    battery_min_soc_entity: "Sensor or number entity reporting the minimum allowed state of charge (%). Helman will not schedule discharging below this level. Part of the battery entity group.",
    battery_max_soc_entity: "Sensor or number entity reporting the maximum allowed state of charge (%). Helman will not schedule charging above this level. Part of the battery entity group.",
    battery_charge_efficiency: "Battery charge round-trip efficiency as a decimal between 0 and 1 (e.g. 0.95 = 95%). Energy stored ÷ energy drawn from the grid. Used by the battery optimizer to accurately model charging costs. Defaults to 0.95 if not set.",
    battery_discharge_efficiency: "Battery discharge round-trip efficiency as a decimal between 0 and 1 (e.g. 0.95 = 95%). Energy delivered ÷ energy stored. Used by the optimizer to model discharge revenue. Defaults to 0.95 if not set.",
    battery_max_charge_power_w: "Maximum battery charge power in watts. Used to model charging speed and duration in the schedule optimizer. Without it, the optimizer cannot accurately estimate charging windows.",
    battery_max_discharge_power_w: "Maximum battery discharge power in watts. Used to model discharge speed and duration in the schedule optimizer. Without it, the optimizer cannot accurately estimate discharge windows.",
    grid_power_entity: "Real-time grid import/export power sensor (W, positive = importing, negative = exporting). Used for live grid monitoring on the dashboard. Optional — grid power is not tracked without it.",
    grid_sell_price_entity: "Entity providing the current grid electricity sell/export price. Used by the battery optimizer to evaluate whether discharging energy to the grid is profitable at a given time. Without it, sell price is treated as zero.",
    grid_import_price_unit: "Unit string shown next to import prices in the dashboard (e.g. CZK/kWh, EUR/kWh). Purely cosmetic — does not affect calculations.",
    import_window_start: "Start time of this import price window in local time (HH:MM). Import price windows must together cover the full 24-hour day without gaps or overlaps.",
    import_window_end: "End time of this import price window in local time (HH:MM). Use 00:00 to indicate midnight end-of-day.",
    import_window_price: "Import electricity price during this time window, in the unit configured above. Used by the battery optimizer to find the cheapest times to charge.",
    scheduler_mode_entity: "Input select or select entity that Helman writes schedule action commands to. Helman sets the option value that corresponds to the desired battery mode (charge, discharge, normal, etc.). Required for the scheduler to actually control the battery.",
    scheduler_action_option: "The option value that Helman will write to the mode entity when this action is scheduled. Must exactly match one of the options in the select entity. Leave empty if this action is not supported by your inverter.",
    automation_optimizer_id: "Unique optimizer identifier stored in automation.optimizers[].id. Keep it stable so future references, logs, and debugging stay readable.",
    export_price_when_price_below: "Threshold in the same unit as the export price forecast. When the forecasted export price drops below this value, the optimizer authors stop_export slots where export is projected.",
    export_price_action: "Phase 5 only supports stop_export. Future phases may add more optimizer actions, but this field is fixed for now.",
    surplus_appliance_id: "Configured appliance id that this optimizer may author. The selector is driven by the current appliances list in the editor, so draft additions and deletions are reflected immediately.",
    surplus_appliance_action: "This optimizer always writes a start action. Generic appliances use on, while climate appliances use the climate mode selected below.",
    surplus_appliance_climate_mode: "Required only for climate appliances. The editor only shows live runtime-supported modes returned for the selected appliance.",
    surplus_appliance_min_surplus_buffer_pct: "Additional buffer above the appliance demand, expressed as a percent. Every covered forecast bucket in a slot must satisfy the buffered surplus before Helman authors the slot.",
    deferrable_consumer_energy_entity: "Cumulative energy sensor (kWh) that tracks this appliance's total electricity consumption. Helman uses its recorded history to estimate how much energy this appliance will consume in upcoming time slots, so it can be deferred to cheaper periods.",
    appliance_id: "Unique internal identifier for this appliance. Used in automation references and schedule tracking. Should not be changed after the appliance is configured, as it may break existing automations.",
    appliance_name: "Display name shown for this appliance in the Helman dashboard and energy breakdowns.",
    ev_max_charging_power_kw: "Maximum charging power of the EV charger in kW. Used by the optimizer to model how quickly the vehicle can be charged and to plan charging windows accordingly.",
    ev_charge_switch_entity: "Switch entity that physically enables or disables EV charging. Helman turns this on or off to implement the charging schedule. Must be the actual control switch of your charger.",
    ev_use_mode_entity: "Select or input_select entity that controls the EV charger's operating mode (e.g. fixed max power, surplus aware). Helman writes the active mode to this entity to implement the scheduled charging behavior.",
    ev_eco_gear_entity: "Select or input_select entity that controls the eco gear level (charging power step) of the EV charger. Helman controls this in surplus-aware mode to throttle charging to available solar surplus.",
    appliance_climate_entity: "Climate entity for this appliance. Helman monitors its active/inactive state (heat or cool mode) to build history-based energy projections. Required for the history_average projection strategy.",
    appliance_switch_entity: "Switch entity that controls this generic appliance. Helman monitors the on/off state history to build energy projections when using the history_average strategy.",
    appliance_projection_strategy: "How Helman estimates this appliance's future energy consumption. Fixed: always uses the configured average hourly energy. History average: learns from the entity's recorded history and falls back to the fixed value if history is insufficient.",
    appliance_hourly_energy_kwh: "Average energy consumption per hour in kWh when the appliance is active. Used directly for the fixed strategy and as a fallback value for history_average when recorded history is insufficient.",
    appliance_history_lookback_days: "How many days back Helman looks when calculating the historical average energy consumption for this appliance. A longer lookback gives more stable estimates but reacts slower to changes in usage patterns.",
    vehicle_id: "Unique internal identifier for this vehicle. Used for tracking charge targets and schedule assignments. Should not be changed after the vehicle is configured.",
    vehicle_soc_entity: "Sensor reporting the vehicle's current battery state of charge as a percentage (0–100). Required for vehicle-aware charging scheduling — Helman uses it to determine how much charging is needed.",
    vehicle_charge_limit_entity: "Number entity reporting the vehicle's configured charge limit as a percentage (0–100). When provided, Helman uses it as the target SoC instead of assuming 100%. Optional.",
    vehicle_battery_capacity_kwh: "Total usable battery capacity of the vehicle in kWh. Required for accurate charge target and duration calculations.",
    vehicle_max_charging_power_kw: "Maximum AC charging power for this vehicle in kW. Used to model how quickly the vehicle charges and to plan charging window durations.",
    bias_correction_enabled: "Enable solar bias correction training. When enabled, Helman automatically trains a forecast correction model based on your actual solar production.",
    bias_correction_min_history_days: "Minimum number of days of recorded solar data before the model can be trained (1-365). A higher value ensures more stable training but delays corrections. Defaults to 10 days.",
    bias_correction_max_training_window_days: "Maximum number of past days Helman may use to train the solar bias correction model. If less history is available, Helman uses what it has; if more is available, Helman caps the training window at this value. A larger maximum produces more stable correction factors but reacts more slowly to seasonal or system changes. Defaults to 90 days.",
    bias_correction_training_time: "Time of day (HH:MM in local time) when automatic training runs, typically during low-activity hours. Training processes historical data to continuously improve forecast accuracy.",
    bias_correction_min_valid_slot_days: "Minimum number of valid historical day-slot samples required before Helman trains a correction factor for a specific slot. Invalidated slot-days do not count. If a slot has fewer valid samples than this threshold, Helman omits the slot from the profile and leaves correction at 0 for that slot. Defaults to 5 days.",
    bias_correction_clamp_min: "Lower bound for the correction factor. Prevents over-correction when the actual production is much lower than the forecast. For example, 0.0 allows the corrected forecast to drop all the way to zero during physically blocked periods. A higher value (closer to 1.0) reduces the correction intensity. Defaults to 0.0.",
    bias_correction_clamp_max: "Upper bound for the correction factor. Prevents over-correction when the actual production is much higher than the forecast. For example, 3.0 ensures the corrected forecast is at most 300% of the original value. A lower value (closer to 1.0) reduces the correction intensity. Defaults to 3.0.",
    bias_correction_max_interpolated_consecutive_slots: "Maximum number of consecutive slots that failed the min_valid_slot_days gate and can be filled via linear interpolation between the nearest healthy neighbors. Slots omitted for other reasons (e.g. forecast floor) are never interpolated. Set to 0 to disable interpolation entirely and preserve legacy behavior. Defaults to 2.",
    bias_correction_aggregation_method: "Method used to aggregate historical data. 'Ratio of Sums' correctly weights clear, sunny days over small, cloudy days and inherently filters out energy sensor quantization noise (recommended). 'Trimmed Mean' calculates the factor for each day independently and averages them after dropping the highest and lowest extremes, providing robustness to single-day anomalies but over-correcting large sunny days due to lack of volume weighting. Defaults to 'Ratio of Sums'.",
    bias_correction_total_energy_entity: "Cumulative solar energy sensor (kWh, ever-increasing) used to build the actual solar generation history for training the correction model.",
    bias_correction_slot_invalidation_max_battery_soc_percent: "Battery state-of-charge threshold as a percentage. When the battery reaches or exceeds this value during a forecast slot and export is disabled in the same slot, Helman excludes that slot from solar bias correction actuals to avoid training on curtailed production.",
    bias_correction_slot_invalidation_export_enabled_entity_id: "Boolean entity that reports whether grid export is currently enabled. Helman combines this with the max battery SoC threshold to invalidate slots where solar production was likely clipped because export was disabled while the battery was effectively full.",
    bias_correction_slot_invalidation_data_glitch_max_slot_wh: "Maximum plausible energy for a single 15-minute slot. A solar inverter cannot exceed its rated power × 0.25 hours; any slot above this cap is a recorder glitch (typically a cumulative-meter dump). Helman invalidates the spike slot and walks backwards through consecutive zero slots to invalidate the matching backfilled energy. Leave empty to derive from power_devices.solar.max_power × 0.25 × 1.05.",
    bias_correction_slot_invalidation_data_glitch_min_neighbour_forecast_wh: "Forecast Wh floor for the zero-with-known-production rule. When a slot's actual is 0 Wh, its forecast was at least this many Wh, and a neighbouring slot within ±60 minutes has non-zero actuals, the slot is treated as a recorder gap and invalidated. Default 200 Wh; set to 0 to disable.",
    bias_correction_slot_invalidation_data_glitch_backfill_max_minutes: "Maximum minutes the backfill walk may extend backwards from a spike. The walk stops at the first non-zero actual or once this window is reached. Default 120 minutes."
  }
}, kt = {
  yes: "Yes",
  no: "No",
  unknown: "Unknown",
  not_available: "N/A"
}, wt = {
  status_panel: {
    subtitle: "Current bias correction status and training controls",
    loading_status: "Loading status...",
    unable_to_load_status: "Unable to load bias correction status",
    home_assistant_not_available: "Home Assistant is not available.",
    failed_to_load_status: "Failed to load status.",
    training_completed: "Training completed successfully.",
    training_failed: "Training failed: {error}",
    unknown_error: "Unknown error",
    section_status: "Status",
    enabled: "Enabled",
    current_status: "Current status",
    trained_at: "Trained at",
    next_training: "Next training",
    effective_variant: "Effective variant",
    training_days_used: "Training days used",
    training_days_required: "{used} / {required} required",
    invalidated_training_slots: "Invalidated training slots",
    invalidated_training_slots_value: "{count} (last training: {trainedAt})",
    insufficient_history_text: "Not enough historical data yet. Have {used} days, need at least {required} days for training.",
    error: "Error",
    dropped_days: "Dropped days",
    actions: "Actions",
    training: "Training...",
    train_now: "Train now",
    refresh_status: "Refresh status",
    info: "Solar bias correction helps adjust solar forecast accuracy based on your system's characteristics. Enable training to automatically improve predictions over time.",
    render_error: "Render error: {error}"
  },
  statuses: {
    applied: "Applied",
    profile_trained: "Profile trained",
    insufficient_history: "Insufficient history",
    config_changed_pending_retrain: "Config changed, retrain pending",
    training_failed: "Training failed",
    not_configured: "Not configured",
    no_training_yet: "No training yet"
  },
  effective_variants: {
    raw: "Raw",
    adjusted: "Adjusted"
  },
  dropped_reasons: {
    day_forecast_too_low: "Day forecast too low",
    day_ratio_out_of_band: "Day ratio out of band"
  },
  error_codes: {
    training_in_progress: "Training is already in progress.",
    bias_correction_not_configured: "Bias correction is not configured.",
    internal_error: "Unexpected solar bias training failure.",
    no_profile: "No solar bias profile is available.",
    not_loaded: "The Helman solar bias correction service is not available.",
    unauthorized: "Admin access is required."
  }
}, Mi = {
  editor: ft,
  common: kt,
  bias_correction: wt
}, Vi = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  bias_correction: wt,
  common: kt,
  default: Mi,
  editor: ft
}, Symbol.toStringTag, { value: "Module" })), ge = {
  cs: Ei,
  en: Vi
};
function ne(a) {
  var t;
  const e = Hi((a == null ? void 0 : a.language) || ((t = a == null ? void 0 : a.locale) == null ? void 0 : t.language) || "cs");
  return (i) => Ci(i, e);
}
function Ci(a, e = "cs") {
  const t = e.replace(/['"]+/g, "").replace("_", "-");
  let i;
  try {
    i = a.split(".").reduce((o, r) => o[r], ge[t]);
  } catch {
    try {
      i = a.split(".").reduce((r, n) => r[n], ge.cs);
    } catch {
      i = a;
    }
  }
  if (i === void 0)
    try {
      i = a.split(".").reduce((o, r) => o[r], ge.cs);
    } catch {
      i = a;
    }
  return i;
}
function Hi(a) {
  return a ? a.substring(0, 2) : "cs";
}
const Ge = [
  "ha-entity-picker",
  "ha-form",
  "ha-formfield",
  "ha-switch"
], Je = "ha-yaml-editor";
let G = null, J = null;
const Li = async () => {
  if (!Ge.every((a) => customElements.get(a))) {
    if (G)
      return G;
    G = (async () => {
      await customElements.whenDefined("partial-panel-resolver");
      const a = document.createElement(
        "partial-panel-resolver"
      );
      a.hass = {
        panels: [
          {
            url_path: "tmp",
            component_name: "config"
          }
        ]
      }, a._updateRoutes(), await a.routerOptions.routes.tmp.load(), await customElements.whenDefined("ha-panel-config"), await document.createElement("ha-panel-config").routerOptions.routes.automation.load(), await Promise.all(Ge.map((t) => customElements.whenDefined(t)));
    })();
    try {
      await G;
    } catch (a) {
      throw G = null, a;
    }
  }
}, Qe = async () => {
  if (!customElements.get(Je)) {
    if (J)
      return J;
    J = (async () => {
      var i, o, r, n, l, d, c;
      await customElements.whenDefined("partial-panel-resolver"), await ((r = (o = (i = document.createElement(
        "partial-panel-resolver"
      ).getRoutes([
        {
          component_name: "developer-tools",
          url_path: "tmp"
        }
      ]).routes) == null ? void 0 : i.tmp) == null ? void 0 : o.load) == null ? void 0 : r.call(o)), await customElements.whenDefined("developer-tools-router"), await ((c = (d = (l = (n = document.createElement(
        "developer-tools-router"
      ).routerOptions) == null ? void 0 : n.routes) == null ? void 0 : l.service) == null ? void 0 : d.load) == null ? void 0 : c.call(d)), await customElements.whenDefined(Je);
    })();
    try {
      await J;
    } catch (a) {
      throw J = null, a;
    }
  }
};
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const Oi = { attribute: !0, type: String, converter: ae, reflect: !1, hasChanged: we }, Pi = (a = Oi, e, t) => {
  const { kind: i, metadata: o } = t;
  let r = globalThis.litPropertyMetadata.get(o);
  if (r === void 0 && globalThis.litPropertyMetadata.set(o, r = /* @__PURE__ */ new Map()), i === "setter" && ((a = Object.create(a)).wrapped = !0), r.set(t.name, a), i === "accessor") {
    const { name: n } = t;
    return { set(l) {
      const d = e.get.call(this);
      e.set.call(this, l), this.requestUpdate(n, d, a, !0, l);
    }, init(l) {
      return l !== void 0 && this.C(n, void 0, a, l), l;
    } };
  }
  if (i === "setter") {
    const { name: n } = t;
    return function(l) {
      const d = this[n];
      e.call(this, l), this.requestUpdate(n, d, a, !0, l);
    };
  }
  throw Error("Unsupported decorator location: " + i);
};
function $t(a) {
  return (e, t) => typeof t == "object" ? Pi(a, e, t) : ((i, o, r) => {
    const n = o.hasOwnProperty(r);
    return o.constructor.createProperty(r, i), n ? Object.getOwnPropertyDescriptor(o, r) : void 0;
  })(a, e, t);
}
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
function W(a) {
  return $t({ ...a, state: !0, attribute: !1 });
}
var Ii = Object.defineProperty, T = (a, e, t, i) => {
  for (var o = void 0, r = a.length - 1, n; r >= 0; r--)
    (n = a[r]) && (o = n(e, t, o) || o);
  return o && Ii(e, t, o), o;
};
const ze = class ze extends D {
  constructor() {
    super(...arguments), this._status = null, this._profile = null, this._loading = !1, this._trainInProgress = !1, this._message = "", this._messageKind = "success", this._fallbackLocalize = ne();
  }
  connectedCallback() {
    super.connectedCallback(), this._loadStatus();
  }
  async _loadStatus() {
    if (!this.hass) {
      this._message = this._t("bias_correction.status_panel.home_assistant_not_available"), this._messageKind = "error", this._loading = !1;
      return;
    }
    this._loading = !0;
    try {
      const e = await this.hass.callWS({ type: "helman/solar_bias/status" });
      this._status = e, (e == null ? void 0 : e.status) === "profile_trained" && await this._loadProfile();
    } catch (e) {
      this._message = this._formatError(e, "bias_correction.status_panel.failed_to_load_status"), this._messageKind = "error", console.error("Error loading bias correction status:", e);
    } finally {
      this._loading = !1, this.requestUpdate();
    }
  }
  async _loadProfile() {
    if (this.hass)
      try {
        const e = await this.hass.callWS({ type: "helman/solar_bias/profile" });
        this._profile = e;
      } catch (e) {
        console.debug("No profile available:", e == null ? void 0 : e.message);
      } finally {
        this.requestUpdate();
      }
  }
  async _trainNow() {
    if (!(this._trainInProgress || !this.hass)) {
      this._trainInProgress = !0, this._message = "";
      try {
        const e = await this.hass.callWS({ type: "helman/solar_bias/train_now" });
        this._status = e, this._message = this._t("bias_correction.status_panel.training_completed"), this._messageKind = "success", (e == null ? void 0 : e.status) === "profile_trained" && await this._loadProfile();
      } catch (e) {
        this._message = this._tFormat("bias_correction.status_panel.training_failed", {
          error: this._formatError(e, "bias_correction.status_panel.unknown_error")
        }), this._messageKind = "error", console.error("Training failed:", e);
      } finally {
        this._trainInProgress = !1, this.requestUpdate();
      }
    }
  }
  _getStatusBadge() {
    var t;
    const e = (t = this._status) == null ? void 0 : t.status;
    switch (e) {
      case "profile_trained":
      case "applied":
        return { text: this._formatStatus(e), class: "badge-success" };
      case "insufficient_history":
      case "config_changed_pending_retrain":
      case "training_failed":
        return { text: this._formatStatus(e), class: "badge-warning" };
      case "not_configured":
      case "no_training_yet":
        return { text: this._formatStatus(e), class: "badge-info" };
      default:
        return { text: this._formatStatus(e), class: "badge-info" };
    }
  }
  _formatDate(e) {
    if (!e) return this._t("common.not_available");
    try {
      return new Date(e).toLocaleString();
    } catch {
      return e;
    }
  }
  _formatStatus(e) {
    return e ? this._tValue(`bias_correction.statuses.${e}`, e) : this._t("common.unknown");
  }
  _formatEffectiveVariant(e) {
    return e ? this._tValue(`bias_correction.effective_variants.${e}`, e) : this._t("common.unknown");
  }
  _formatDroppedReason(e) {
    return e ? this._tValue(`bias_correction.dropped_reasons.${e}`, e) : this._t("common.unknown");
  }
  _formatError(e, t) {
    const i = typeof (e == null ? void 0 : e.code) == "string" ? e.code : void 0;
    if (i) {
      const o = this._tValue(`bias_correction.error_codes.${i}`, "");
      if (o) return o;
    }
    return typeof (e == null ? void 0 : e.message) == "string" && e.message ? e.message : this._t(t);
  }
  render() {
    var e;
    if (this._loading)
      return s`<div class="container"><p>${this._t("bias_correction.status_panel.loading_status")}</p></div>`;
    if (!this._status)
      return s`<div class="container"><div class="info-box">${this._t("bias_correction.status_panel.unable_to_load_status")}</div></div>`;
    try {
      const t = this._getStatusBadge();
      return s`
        <div class="container">
          <div class="section">
            <div class="section-title">${this._t("bias_correction.status_panel.section_status")}</div>
            <div class="status-grid">
              <div class="status-row">
                <span class="status-label">${this._t("bias_correction.status_panel.enabled")}</span>
                <span class="status-value">${this._status.enabled ? this._t("common.yes") : this._t("common.no")}</span>
              </div>
              <div class="status-row">
                <span class="status-label">${this._t("bias_correction.status_panel.current_status")}</span>
                <span class="badge ${t.class}">${t.text}</span>
              </div>
              ${this._status.trainedAt ? s`
                    <div class="status-row">
                      <span class="status-label">${this._t("bias_correction.status_panel.trained_at")}</span>
                      <span class="status-value">${this._formatDate(this._status.trainedAt)}</span>
                    </div>
                  ` : ""}
              ${this._status.nextScheduledTrainingAt ? s`
                    <div class="status-row">
                      <span class="status-label">${this._t("bias_correction.status_panel.next_training")}</span>
                      <span class="status-value">${this._formatDate(this._status.nextScheduledTrainingAt)}</span>
                    </div>
                  ` : ""}
              <div class="status-row">
                <span class="status-label">${this._t("bias_correction.status_panel.effective_variant")}</span>
                <span class="status-value">${this._formatEffectiveVariant(this._status.effectiveVariant)}</span>
              </div>
              <div class="status-row">
                <span class="status-label">${this._t("bias_correction.status_panel.training_days_used")}</span>
                <span class="status-value">${this._tFormat("bias_correction.status_panel.training_days_required", {
        used: this._status.usableDays,
        required: this._status.minHistoryDays
      })}</span>
              </div>
              ${this._status.slotInvalidationEnabled || this._status.invalidatedSlotCount > 0 ? s`
                    <div class="status-row">
                      <span class="status-label">${this._t("bias_correction.status_panel.invalidated_training_slots")}</span>
                      <span class="status-value">${this._tFormat("bias_correction.status_panel.invalidated_training_slots_value", {
        count: this._status.invalidatedSlotCount ?? 0,
        trainedAt: this._formatDate(this._status.trainedAt)
      })}</span>
                    </div>
                  ` : ""}
              ${this._status.status === "insufficient_history" ? s`
                    <div class="info-box" style="margin-top: 8px;">
                      ${this._tFormat("bias_correction.status_panel.insufficient_history_text", {
        used: this._status.usableDays,
        required: this._status.minHistoryDays
      })}
                    </div>
                  ` : ""}
              ${this._status.errorReason ? s`
                    <div class="status-row" style="background: rgba(198, 40, 40, 0.1);">
                      <span class="status-label">${this._t("bias_correction.status_panel.error")}</span>
                      <span class="status-value" style="color: #c62828;">${this._status.errorReason}</span>
                    </div>
                  ` : ""}
            </div>
          </div>

          ${this._status.droppedDays && this._status.droppedDays.length > 0 ? s`
                <div class="section">
                  <div class="section-title">${this._t("bias_correction.status_panel.dropped_days")}</div>
                  <div style="font-size: 0.9rem; color: var(--secondary-text-color);">
                    ${this._status.droppedDays.map((i) => s`
                      <div style="padding: 4px 0;">
                        <strong>${i.date}:</strong> ${this._formatDroppedReason(i.reason)}
                      </div>
                    `)}
                  </div>
                </div>
              ` : ""}

          <div class="section">
            <div class="section-title">${this._t("bias_correction.status_panel.actions")}</div>
            <div class="controls">
              <button
                class="primary"
                @click=${this._trainNow}
                ?disabled=${this._trainInProgress || ((e = this._status) == null ? void 0 : e.enabled) === !1}
              >
                ${this._trainInProgress ? s`<span class="spinner"></span> ${this._t("bias_correction.status_panel.training")}` : this._t("bias_correction.status_panel.train_now")}
              </button>
              <button
                @click=${this._loadStatus}
                ?disabled=${this._loading}
              >
                ${this._t("bias_correction.status_panel.refresh_status")}
              </button>
            </div>
          </div>

          ${this._message ? s`
                <div class="message ${this._messageKind}">
                  ${this._message}
                </div>
              ` : ""}

          <div class="info-box">
            ${this._t("bias_correction.status_panel.info")}
          </div>
        </div>
      `;
    } catch (t) {
      return console.error("Render error:", t), s`<div class="container"><div class="info-box" style="color: red;">${this._tFormat("bias_correction.status_panel.render_error", {
        error: (t == null ? void 0 : t.message) ?? this._t("common.unknown")
      })}</div></div>`;
    }
  }
  _t(e) {
    return ne(this.hass ?? void 0)(e) ?? this._fallbackLocalize(e) ?? e;
  }
  _tValue(e, t) {
    const i = this._t(e);
    return i === e ? t : i;
  }
  _tFormat(e, t) {
    let i = this._t(e) || e;
    for (const [o, r] of Object.entries(t))
      i = i.replaceAll(`{${o}}`, String(r));
    return i;
  }
};
ze.styles = at`
    .container {
      padding: 16px;
      display: grid;
      gap: 20px;
    }

    .section {
      display: grid;
      gap: 12px;
    }

    .section-title {
      font-weight: 600;
      font-size: 0.95rem;
      color: var(--primary-text-color);
      border-bottom: 1px solid var(--divider-color);
      padding-bottom: 8px;
    }

    .status-grid {
      display: grid;
      gap: 8px;
    }

    .status-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px;
      background: var(--secondary-background-color);
      border-radius: 6px;
      border: 1px solid var(--divider-color);
    }

    .status-label {
      font-weight: 500;
      color: var(--primary-text-color);
    }

    .status-value {
      color: var(--secondary-text-color);
      font-size: 0.9rem;
    }

    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 0.85rem;
      font-weight: 600;
    }

    .badge-success {
      background: rgba(46, 125, 50, 0.2);
      color: #2e7d32;
    }

    .badge-warning {
      background: rgba(245, 127, 23, 0.2);
      color: #f57f17;
    }

    .badge-error {
      background: rgba(198, 40, 40, 0.2);
      color: #c62828;
    }

    .badge-info {
      background: rgba(33, 150, 243, 0.2);
      color: #1976d2;
    }

    .controls {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }

    button {
      padding: 8px 16px;
      border: 1px solid var(--divider-color);
      border-radius: 6px;
      background: var(--card-background-color);
      color: var(--primary-text-color);
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }

    button:hover:not(:disabled) {
      background: var(--secondary-background-color);
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    button.primary {
      background: var(--primary-color);
      color: white;
      border-color: var(--primary-color);
    }

    button.primary:hover:not(:disabled) {
      opacity: 0.9;
    }

    .info-box {
      padding: 12px;
      background: rgba(33, 150, 243, 0.1);
      border-left: 3px solid var(--primary-color);
      border-radius: 4px;
      font-size: 0.9rem;
      color: var(--primary-text-color);
    }

    .message {
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 0.9rem;
    }

    .message.success {
      background: rgba(46, 125, 50, 0.2);
      color: #2e7d32;
    }

    .message.error {
      background: rgba(198, 40, 40, 0.2);
      color: #c62828;
    }

    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: currentColor;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .profile-section {
      background: var(--secondary-background-color);
      padding: 12px;
      border-radius: 6px;
      border: 1px solid var(--divider-color);
    }

    .profile-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    .profile-list li {
      padding: 4px 0;
      font-size: 0.9rem;
    }
  `;
let A = ze;
T([
  $t({ attribute: !1 })
], A.prototype, "hass");
T([
  W()
], A.prototype, "_status");
T([
  W()
], A.prototype, "_profile");
T([
  W()
], A.prototype, "_loading");
T([
  W()
], A.prototype, "_trainInProgress");
T([
  W()
], A.prototype, "_message");
T([
  W()
], A.prototype, "_messageKind");
customElements.define("helman-bias-correction-status", A);
const ve = "YAML must resolve to JSON-compatible scalars, arrays, and objects.";
function Xe(a) {
  try {
    return {
      ok: !0,
      value: ye(a)
    };
  } catch {
    return { ok: !1, code: "non_json_value" };
  }
}
function ye(a) {
  if (a === null)
    return null;
  if (typeof a == "string" || typeof a == "boolean")
    return a;
  if (typeof a == "number") {
    if (!Number.isFinite(a))
      throw new Error(ve);
    return a;
  }
  if (Array.isArray(a))
    return a.map((e) => ye(e));
  if (typeof a == "object") {
    const e = Object.getPrototypeOf(a);
    if (e !== Object.prototype && e !== null)
      throw new Error(ve);
    const t = {};
    for (const [i, o] of Object.entries(a))
      t[i] = ye(o);
    return t;
  }
  throw new Error(ve);
}
const Ti = [
  { value: "fixed_max_power", labelKey: "editor.values.fixed_max_power" },
  { value: "surplus_aware", labelKey: "editor.values.surplus_aware" }
], Ni = [
  { value: "fixed", labelKey: "editor.values.fixed" },
  { value: "history_average", labelKey: "editor.values.history_average" }
], Ri = "export_price", Fi = "stop_export", et = "surplus_appliance", Di = "on", Yi = {
  icon: {}
}, se = class se extends D {
  constructor() {
    super(...arguments), this._fallbackLocalize = ne(), this._activeTab = "general", this._config = null, this._dirty = !1, this._loading = !1, this._saving = !1, this._validating = !1, this._validation = null, this._message = null, this._hasLoadedOnce = !1, this._scopeModes = {}, this._scopeYamlValues = {}, this._scopeYamlErrors = {}, this._applianceModes = {}, this._applianceYamlValues = {}, this._applianceYamlErrors = {}, this._liveApplianceMetadata = null, this._helpDialog = null, this._preventSummaryToggle = (e) => {
      e.preventDefault(), e.stopPropagation();
    }, this._stopSummaryToggle = (e) => {
      e.stopPropagation();
    }, this._closeHelp = () => {
      this._helpDialog = null;
    }, this._handleReloadClick = async () => {
      (this._dirty || this._hasBlockingYamlErrors()) && !window.confirm(this._t("editor.confirm.discard_changes")) || await this._loadConfig({ showMessage: !0 });
    }, this._handleValidateClick = async () => {
      await this._validateConfig();
    }, this._handleSaveClick = async () => {
      await this._saveConfig();
    }, this._handleAddDeviceLabelCategory = () => {
      const e = M(this._getValue(["device_label_text"])).map(
        ([i]) => i
      ), t = Xt(e);
      this._applyMutation((i) => {
        g(i, ["device_label_text", t], {});
      });
    }, this._handleAddDeferrableConsumer = () => {
      var t;
      const e = ((t = $(
        this._getValue(["power_devices", "house", "forecast", "deferrable_consumers"])
      )) == null ? void 0 : t.length) ?? 0;
      this._applyMutation((i) => {
        S(
          i,
          ["power_devices", "house", "forecast", "deferrable_consumers"],
          ni(
            this._tFormat("editor.dynamic.consumer", { index: e + 1 })
          )
        );
      });
    }, this._handleAddDailyEnergyEntity = () => {
      this._applyMutation((e) => {
        S(
          e,
          ["power_devices", "solar", "forecast", "daily_energy_entity_ids"],
          li()
        );
      });
    }, this._handleAddImportPriceWindow = () => {
      this._applyMutation((e) => {
        S(
          e,
          ["power_devices", "grid", "forecast", "import_price_windows"],
          si()
        );
      });
    }, this._handleAddExportPriceOptimizer = () => {
      const e = ($(this._getValue(["automation", "optimizers"])) ?? []).map((t) => {
        var i;
        return this._stringValue((i = y(t)) == null ? void 0 : i.id);
      }).filter((t) => t.length > 0);
      this._applyMutation((t) => {
        if (!y(f(t, ["automation"]))) {
          g(t, ["automation"], {
            enabled: !0,
            optimizers: [Ue(e)]
          });
          return;
        }
        S(
          t,
          ["automation", "optimizers"],
          Ue(e)
        );
      });
    }, this._handleAddSurplusApplianceOptimizer = () => {
      const e = ($(this._getValue(["automation", "optimizers"])) ?? []).map((t) => {
        var i;
        return this._stringValue((i = y(t)) == null ? void 0 : i.id);
      }).filter((t) => t.length > 0);
      this._applyMutation((t) => {
        if (!y(f(t, ["automation"]))) {
          g(t, ["automation"], {
            enabled: !0,
            optimizers: [Ke(e)]
          });
          return;
        }
        S(
          t,
          ["automation", "optimizers"],
          Ke(e)
        );
      });
    }, this._handleAddEvCharger = () => {
      const e = ($(this._getValue(["appliances"])) ?? []).map((t) => {
        var i;
        return this._stringValue((i = y(t)) == null ? void 0 : i.id);
      }).filter((t) => t.length > 0);
      this._applyMutation((t) => {
        S(
          t,
          ["appliances"],
          ti(
            e,
            this._tFormat("editor.dynamic.ev_charger", { index: e.length + 1 }),
            this._tFormat("editor.dynamic.vehicle", { index: 1 })
          )
        );
      });
    }, this._handleAddClimateAppliance = () => {
      const e = ($(this._getValue(["appliances"])) ?? []).map((t) => {
        var i;
        return this._stringValue((i = y(t)) == null ? void 0 : i.id);
      }).filter((t) => t.length > 0);
      this._applyMutation((t) => {
        S(
          t,
          ["appliances"],
          oi(
            e,
            this._tFormat("editor.dynamic.climate_appliance", {
              index: e.length + 1
            })
          )
        );
      });
    }, this._handleAddGenericAppliance = () => {
      const e = ($(this._getValue(["appliances"])) ?? []).map((t) => {
        var i;
        return this._stringValue((i = y(t)) == null ? void 0 : i.id);
      }).filter((t) => t.length > 0);
      this._applyMutation((t) => {
        S(
          t,
          ["appliances"],
          ii(
            e,
            this._tFormat("editor.dynamic.generic_appliance", {
              index: e.length + 1
            })
          )
        );
      });
    };
  }
  get hass() {
    return this._hass;
  }
  set hass(e) {
    const t = this._hass;
    this._hass = e, e && !this._localize && (this._localize = ne(e)), this.requestUpdate("hass", t);
  }
  connectedCallback() {
    super.connectedCallback(), Li().then(() => {
      this.requestUpdate();
    }).catch((e) => {
      this._message = {
        kind: "error",
        text: this._formatError(
          e,
          this._t("editor.messages.load_ha_form_failed")
        )
      };
    });
  }
  updated(e) {
    super.updated(e), !this._hasLoadedOnce && this.hass && (this._hasLoadedOnce = !0, this._loadConfig({ showMessage: !1 }));
  }
  render() {
    var i;
    const e = this._buildTabIssueCounts(), t = this._hasBlockingYamlErrors();
    return s`
      <div class="page">
        <div class="header">
          <div class="title-block">
            <h1>${this._t("editor.title")}</h1>
            <p>
              ${this._t("editor.description")}
            </p>
          </div>
          <div class="actions">
            ${this._renderModeToggle(z)}
            <button
              type="button"
              ?disabled=${this._loading || this._saving || this._validating}
              @click=${this._handleReloadClick}
            >
              ${this._t("editor.actions.reload_config")}
            </button>
            <button
              type="button"
              ?disabled=${this._loading || this._saving || this._validating || !this._config || t}
              @click=${this._handleValidateClick}
            >
              ${this._validating ? this._t("editor.actions.validating") : this._t("editor.actions.validate")}
            </button>
            <button
              type="button"
              class="primary"
              ?disabled=${this._loading || this._saving || this._validating || !this._config || t}
              @click=${this._handleSaveClick}
            >
              ${this._saving ? this._t("editor.actions.saving") : this._t("editor.actions.save_and_reload")}
            </button>
          </div>
        </div>

        <div class="status-row">
          ${this._loading ? s`<span class="badge info">${this._t("editor.status.loading_config")}</span>` : u}
          ${this._dirty ? s`<span class="badge info">${this._t("editor.status.unsaved_changes")}</span>` : s`<span class="badge info">${this._t("editor.status.stored_config_loaded")}</span>`}
          ${!this._dirty && ((i = this._validation) != null && i.valid) ? s`<span class="badge info">${this._t("editor.status.last_validation_passed")}</span>` : u}
          ${this._dirty ? s`<span class="badge info">${this._t("editor.status.validation_stale")}</span>` : u}
          ${t ? s`<span class="badge info">${this._t("editor.status.fix_yaml_errors")}</span>` : u}
        </div>

        ${this._message ? s`<div class="message ${this._message.kind}">${this._message.text}</div>` : u}

        ${this._renderIssueBoard()}

        ${this._config ? this._renderDocumentBody(e) : u}
      </div>
      ${this._renderHelpDialog()}
    `;
  }
  _renderDocumentBody(e) {
    return this._isScopeYaml(z) ? s`<div class="list-card">${this._renderYamlEditor(z)}</div>` : s`
      <div class="tabs">
        ${fi.map((t) => {
      const i = e[t.id];
      return s`
            <button
              type="button"
              class=${this._activeTab === t.id ? "active" : ""}
              @click=${() => {
        this._activeTab = t.id;
      }}
            >
              ${this._renderSvgIcon(yi[t.id], "tab-icon")}
              <span>${this._t(t.labelKey)}</span>
              ${i.errors > 0 ? s`<span class="tab-count errors">${i.errors}</span>` : i.warnings > 0 ? s`<span class="tab-count warnings">${i.warnings}</span>` : u}
            </button>
          `;
    })}
      </div>

      ${Zt(this._renderActiveTab())}
    `;
  }
  _renderActiveTab() {
    switch (this._activeTab) {
      case "general":
        return this._renderTabScope(v.general, this._renderGeneralTab());
      case "power_devices":
        return this._renderTabScope(
          v.power_devices,
          this._renderPowerDevicesTab()
        );
      case "scheduler":
        return this._renderTabScope(v.scheduler, this._renderSchedulerTab());
      case "automation":
        return this._renderTabScope(
          v.automation,
          this._renderAutomationTab()
        );
      case "appliances":
        return this._renderTabScope(
          v.appliances,
          this._renderAppliancesTab()
        );
      default:
        return s``;
    }
  }
  _renderTabScope(e, t) {
    return s`
      <div class="tab-scope">
        <div class="scope-toolbar">
          ${this._renderModeToggle(e)}
        </div>
        ${this._isScopeYaml(e) ? s`<div class="list-card">${this._renderYamlEditor(e)}</div>` : s`<div class="tab-body">${t}</div>`}
      </div>
    `;
  }
  _renderSectionScope(e, t, i = {}) {
    const o = Z(e), { initialOpen: r = !0 } = i, n = bi[e];
    return s`
      <details class="section-card" ?open=${r}>
        <summary>
          <div class="section-summary-row">
            <div class="section-summary-left">
              ${n ? this._renderSvgIcon(n, "section-icon") : u}
              <span class="section-summary-label">${this._t(o.labelKey)}</span>
            </div>
            <div style="display:flex;align-items:center;gap:8px;" @click=${this._preventSummaryToggle}>
              ${this._renderModeToggle(e, { inSummary: !1 })}
            </div>
            ${this._renderSvgIcon("M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z", "section-chevron")}
          </div>
        </summary>
        <div class="section-content">
          ${this._isScopeYaml(e) ? this._renderYamlEditor(e) : t}
        </div>
      </details>
    `;
  }
  _renderSvgIcon(e, t) {
    return s`<svg class=${t} viewBox="0 0 24 24" aria-hidden="true"><path d=${e}/></svg>`;
  }
  _renderSimpleSection(e, t, i = {}) {
    const { open: o = !0 } = i;
    return s`
      <details class="section-card" ?open=${o}>
        <summary>
          <div class="section-summary-row">
            <div class="section-summary-left">
              <span class="section-summary-label">${e}</span>
            </div>
            ${this._renderSvgIcon("M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z", "section-chevron")}
          </div>
        </summary>
        <div class="section-content">${t}</div>
      </details>
    `;
  }
  _getApplianceMode(e) {
    return this._applianceModes[e] ?? "visual";
  }
  _renderApplianceModeToggle(e) {
    const t = this._getApplianceMode(e);
    return s`
      <div class="mode-toggle">
        <button
          type="button"
          class=${t === "visual" ? "active" : ""}
          aria-pressed=${t === "visual"}
          @click=${(i) => this._handleApplianceModeChange(e, "visual", i)}
        >
          ${this._t("editor.mode.visual")}
        </button>
        <button
          type="button"
          class=${t === "yaml" ? "active" : ""}
          aria-pressed=${t === "yaml"}
          @click=${(i) => this._handleApplianceModeChange(e, "yaml", i)}
        >
          ${this._t("editor.mode.yaml")}
        </button>
      </div>
    `;
  }
  _handleApplianceModeChange(e, t, i) {
    i.preventDefault(), i.stopPropagation(), t === "yaml" ? this._enterApplianceYamlMode(e) : this._exitApplianceYamlMode(e);
  }
  async _enterApplianceYamlMode(e) {
    if (this._getApplianceMode(e) !== "yaml")
      try {
        if (await Qe(), !this._config) return;
        const t = this._getValue(["appliances", e]);
        this._applianceModes = { ...this._applianceModes, [e]: "yaml" }, this._applianceYamlValues = { ...this._applianceYamlValues, [e]: t };
        const i = { ...this._applianceYamlErrors };
        delete i[e], this._applianceYamlErrors = i, this._message = null;
      } catch (t) {
        this._message = {
          kind: "error",
          text: this._formatError(t, this._t("editor.messages.load_ha_yaml_editor_failed"))
        };
      }
  }
  _exitApplianceYamlMode(e) {
    if (this._getApplianceMode(e) !== "yaml" || this._applianceYamlErrors[e]) return;
    const t = { ...this._applianceModes };
    delete t[e];
    const i = { ...this._applianceYamlValues };
    delete i[e];
    const o = { ...this._applianceYamlErrors };
    delete o[e], this._applianceModes = t, this._applianceYamlValues = i, this._applianceYamlErrors = o;
  }
  _handleApplianceYamlChanged(e, t) {
    if (t.stopPropagation(), !t.detail.isValid) {
      this._applianceYamlErrors = {
        ...this._applianceYamlErrors,
        [e]: t.detail.errorMsg ?? this._t("editor.yaml.errors.parse_failed")
      };
      return;
    }
    const i = Xe(t.detail.value);
    if (!i.ok) {
      this._applianceYamlErrors = {
        ...this._applianceYamlErrors,
        [e]: this._t("editor.yaml.errors.non_json_value")
      };
      return;
    }
    if (!Array.isArray(i.value) && typeof i.value != "object") {
      this._applianceYamlErrors = {
        ...this._applianceYamlErrors,
        [e]: this._t("editor.yaml.errors.non_json_value")
      };
      return;
    }
    try {
      const o = w(this._config ?? {});
      g(o, ["appliances", e], w(i.value)), this._config = o, this._dirty = !0, this._validation = null, this._message = null, this._applianceYamlValues = { ...this._applianceYamlValues, [e]: i.value };
      const r = { ...this._applianceYamlErrors };
      delete r[e], this._applianceYamlErrors = r;
    } catch (o) {
      this._applianceYamlErrors = {
        ...this._applianceYamlErrors,
        [e]: this._formatError(o, this._t("editor.yaml.errors.apply_failed"))
      };
    }
  }
  _renderApplianceYamlEditor(e) {
    const t = this._applianceYamlErrors[e], i = `appliance-${e}`, o = `${i}-yaml-helper`, r = `${i}-yaml-error`, n = t ? `${o} ${r}` : o, l = this._applianceYamlValues[e] ?? this._getValue(["appliances", e]);
    return s`
      <div class="yaml-surface">
        <div class="field yaml-field">
          <label>${this._t("editor.yaml.field_label")}</label>
          <div id=${o} class="helper">${this._t("editor.yaml.helpers.section")}</div>
          <ha-yaml-editor
            .hass=${this.hass}
            .defaultValue=${l}
            .showErrors=${!1}
            aria-describedby=${n}
            @value-changed=${(d) => this._handleApplianceYamlChanged(e, d)}
          ></ha-yaml-editor>
        </div>
        ${t ? s`<div id=${r} class="message error">${t}</div>` : u}
      </div>
    `;
  }
  _renderModeToggle(e, t = {}) {
    const i = this._getScopeMode(e);
    return s`
      <div
        class="mode-toggle"
        @click=${t.inSummary ? this._preventSummaryToggle : void 0}
      >
        <button
          type="button"
          class=${i === "visual" ? "active" : ""}
          aria-pressed=${i === "visual"}
          @click=${(o) => this._handleScopeModeSelection(e, "visual", o)}
        >
          ${this._t("editor.mode.visual")}
        </button>
        <button
          type="button"
          class=${i === "yaml" ? "active" : ""}
          aria-pressed=${i === "yaml"}
          @click=${(o) => this._handleScopeModeSelection(e, "yaml", o)}
        >
          ${this._t("editor.mode.yaml")}
        </button>
      </div>
    `;
  }
  _renderYamlEditor(e) {
    const t = Z(e), i = this._t(t.labelKey), o = t.kind === "document" ? "editor.yaml.helpers.document" : t.kind === "tab" ? "editor.yaml.helpers.tab" : "editor.yaml.helpers.section", r = this._scopeYamlErrors[e], n = this._scopeDomId(e), l = `${n}-yaml-helper`, d = `${n}-yaml-error`, c = r ? `${l} ${d}` : l, h = this._scopeYamlValues[e] ?? t.adapter.read(this._config ?? {});
    return s`
      <div class="yaml-surface">
        <div
          class=${[
      "field",
      "yaml-field",
      t.kind === "document" ? "yaml-field--document" : ""
    ].filter((_) => _.length > 0).join(" ")}
        >
          <label>${this._t("editor.yaml.field_label")}</label>
          <div id=${l} class="helper">${this._t(o)}</div>
          <ha-yaml-editor
            .hass=${this.hass}
            .defaultValue=${h}
            .showErrors=${!1}
            aria-label=${this._tFormat("editor.yaml.aria_label", { scope: i })}
            aria-describedby=${c}
            dir="ltr"
            @value-changed=${(_) => this._handleYamlValueChanged(e, _)}
          ></ha-yaml-editor>
        </div>
        ${r ? s`
              <div id=${d} class="message error yaml-error">
                <div>${r}</div>
                <div class="helper">${this._t("editor.yaml.errors.fix_before_leaving")}</div>
              </div>
            ` : u}
      </div>
    `;
  }
  _renderGeneralTab() {
    return s`
      ${this._renderSectionScope(
      p.general.core_labels_and_history,
      s`
          <div class="field-grid">
            ${this._renderOptionalNumberField(
        ["history_buckets"],
        "editor.fields.history_buckets",
        "editor.helpers.history_buckets",
        "editor.help.history_buckets"
      )}
            ${this._renderOptionalNumberField(
        ["history_bucket_duration"],
        "editor.fields.history_bucket_duration",
        "editor.helpers.history_bucket_duration",
        "editor.help.history_bucket_duration"
      )}
            ${this._renderOptionalTextField(["sources_title"], "editor.fields.sources_title")}
            ${this._renderOptionalTextField(["consumers_title"], "editor.fields.consumers_title")}
            ${this._renderOptionalTextField(["groups_title"], "editor.fields.groups_title")}
            ${this._renderOptionalTextField(["others_group_label"], "editor.fields.others_group_label")}
            ${this._renderOptionalTextField(
        ["power_sensor_name_cleaner_regex"],
        "editor.fields.power_sensor_name_cleaner_regex",
        "editor.helpers.power_sensor_name_cleaner_regex",
        "editor.help.power_sensor_name_cleaner_regex"
      )}
            ${this._renderBooleanField(
        ["show_empty_groups"],
        "editor.fields.show_empty_groups",
        !1
      )}
            ${this._renderBooleanField(
        ["show_others_group"],
        "editor.fields.show_others_group",
        !0
      )}
          </div>
        `
    )}

      ${this._renderSectionScope(
      p.general.device_label_text,
      s`
          <p class="inline-note">
            ${this._t("editor.notes.device_label_text")}
          </p>
          <div class="list-stack">
            ${this._renderDeviceLabelCategories()}
          </div>
          <div class="section-footer">
            <button type="button" class="add-button" @click=${this._handleAddDeviceLabelCategory}>
              ${this._t("editor.actions.add_category")}
            </button>
          </div>
        `
    )}
    `;
  }
  _renderPowerDevicesTab() {
    var o, r, n, l;
    const e = $(this._getValue(["power_devices", "solar", "forecast", "daily_energy_entity_ids"])) ?? [], t = $(
      this._getValue(["power_devices", "house", "forecast", "deferrable_consumers"])
    ) ?? [], i = $(this._getValue(["power_devices", "grid", "forecast", "import_price_windows"])) ?? [];
    return s`
      ${this._renderSectionScope(
      p.power_devices.house,
      s`
          <div class="field-grid">
            ${this._renderRequiredEntityField(
        ["power_devices", "house", "entities", "power"],
        "editor.fields.house_power_entity",
        ["sensor"],
        void 0,
        void 0,
        "editor.help.house_power_entity"
      )}
            ${this._renderOptionalTextField(
        ["power_devices", "house", "power_sensor_label"],
        "editor.fields.power_sensor_label"
      )}
            ${this._renderOptionalTextField(
        ["power_devices", "house", "power_switch_label"],
        "editor.fields.power_switch_label"
      )}
            ${this._renderOptionalTextField(
        ["power_devices", "house", "unmeasured_power_title"],
        "editor.fields.unmeasured_power_title"
      )}
            ${this._renderOptionalEntityField(
        ["power_devices", "house", "forecast", "total_energy_entity_id"],
        "editor.fields.forecast_total_energy_entity",
        ["sensor"],
        void 0,
        "editor.help.house_forecast_total_energy_entity"
      )}
            ${this._renderOptionalNumberField(
        ["power_devices", "house", "forecast", "min_history_days"],
        "editor.fields.min_history_days",
        void 0,
        "editor.help.house_min_history_days"
      )}
            ${this._renderOptionalNumberField(
        ["power_devices", "house", "forecast", "training_window_days"],
        "editor.fields.training_window_days",
        void 0,
        "editor.help.house_training_window_days"
      )}
          </div>

          <div class="list-stack">
            ${t.map(
        (d, c) => this._renderDeferrableConsumer(d, c, t.length)
      )}
          </div>
          <div class="section-footer">
            <button type="button" class="add-button" @click=${this._handleAddDeferrableConsumer}>
              ${this._t("editor.actions.add_deferrable_consumer")}
            </button>
          </div>
        `,
      { initialOpen: !1 }
    )}

      ${this._renderSectionScope(
      p.power_devices.solar,
      s`
          ${this._renderSectionScope(
        p.power_devices.solar_general,
        s`
              <div class="field-grid field-grid--roomy">
                ${this._renderOptionalEntityField(
          ["power_devices", "solar", "entities", "power"],
          "editor.fields.power_entity",
          ["sensor"],
          void 0,
          "editor.help.solar_power_entity"
        )}
                ${this._renderOptionalEntityField(
          ["power_devices", "solar", "entities", "today_energy"],
          "editor.fields.today_energy_entity",
          ["sensor"],
          void 0,
          "editor.help.solar_today_energy_entity"
        )}
                ${this._renderOptionalEntityField(
          [
            "power_devices",
            "solar",
            "entities",
            "remaining_today_energy_forecast"
          ],
          "editor.fields.remaining_today_energy_forecast",
          ["sensor"],
          void 0,
          "editor.help.solar_remaining_today_energy_forecast"
        )}
              </div>
            `,
        { initialOpen: !1 }
      )}

          ${this._renderSectionScope(
        p.power_devices.solar_forecast,
        s`
              ${this._renderSectionScope(
          p.power_devices.solar_forecast_general,
          s`
                  <div class="field-grid field-grid--roomy">
                    ${this._renderOptionalEntityField(
            ["power_devices", "solar", "forecast", "total_energy_entity_id"],
            "editor.fields.forecast_total_energy_entity",
            ["sensor"],
            void 0,
            "editor.help.solar_forecast_total_energy_entity"
          )}
                  </div>

                  <div class="list-stack">
                    ${e.map(
            (d, c) => this._renderDailyEnergyEntity(d, c, e.length)
          )}
                  </div>
                  <div class="section-footer">
                    <button type="button" class="add-button" @click=${this._handleAddDailyEnergyEntity}>
                      ${this._t("editor.actions.add_daily_energy_entity")}
                    </button>
                  </div>
                `,
          { initialOpen: !1 }
        )}

              ${this._renderSectionScope(
          p.power_devices.solar_bias_correction,
          s`
                  ${this._renderSectionScope(
            p.power_devices.solar_bias_correction_config,
            s`
                      <div class="field-grid">
                        ${this._renderBooleanField(
              ["power_devices", "solar", "forecast", "bias_correction", "enabled"],
              "editor.fields.bias_correction_enabled",
              !1
            )}
                        ${this._renderOptionalNumberField(
              ["power_devices", "solar", "forecast", "bias_correction", "min_history_days"],
              "editor.fields.bias_correction_min_history_days",
              "editor.helpers.bias_correction_min_history_days",
              "editor.help.bias_correction_min_history_days"
            )}
                        ${this._renderOptionalNumberField(
              ["power_devices", "solar", "forecast", "bias_correction", "max_training_window_days"],
              "editor.fields.max_training_window_days",
              "editor.helpers.bias_correction_max_training_window_days",
              "editor.help.bias_correction_max_training_window_days"
            )}
                        ${this._renderOptionalTextField(
              ["power_devices", "solar", "forecast", "bias_correction", "training_time"],
              "editor.fields.bias_correction_training_time",
              "editor.helpers.bias_correction_training_time",
              "editor.help.bias_correction_training_time"
            )}
                        ${this._renderOptionalNumberField(
              ["power_devices", "solar", "forecast", "bias_correction", "min_valid_slot_days"],
              "editor.fields.bias_correction_min_valid_slot_days",
              "editor.helpers.bias_correction_min_valid_slot_days",
              "editor.help.bias_correction_min_valid_slot_days"
            )}
                        ${this._renderOptionalNumberField(
              ["power_devices", "solar", "forecast", "bias_correction", "clamp_min"],
              "editor.fields.bias_correction_clamp_min",
              void 0,
              "editor.help.bias_correction_clamp_min"
            )}
                        ${this._renderOptionalNumberField(
              ["power_devices", "solar", "forecast", "bias_correction", "clamp_max"],
              "editor.fields.bias_correction_clamp_max",
              void 0,
              "editor.help.bias_correction_clamp_max"
            )}
                        ${this._renderOptionalSelectField(
              ["power_devices", "solar", "forecast", "bias_correction", "aggregation_method"],
              "editor.fields.bias_correction_aggregation_method",
              [
                { value: "ratio_of_sums", label: ((r = (o = this.hass) == null ? void 0 : o.localize) == null ? void 0 : r.call(o, "component.helman.editor.fields.bias_correction_aggregation_method_ratio_of_sums")) || "Ratio of Sums" },
                { value: "trimmed_mean", label: ((l = (n = this.hass) == null ? void 0 : n.localize) == null ? void 0 : l.call(n, "component.helman.editor.fields.bias_correction_aggregation_method_trimmed_mean")) || "Trimmed Mean" }
              ],
              "editor.help.bias_correction_aggregation_method"
            )}
                        ${this._renderOptionalNumberField(
              ["power_devices", "solar", "forecast", "bias_correction", "max_interpolated_consecutive_slots"],
              "editor.fields.bias_correction_max_interpolated_consecutive_slots",
              "editor.helpers.bias_correction_max_interpolated_consecutive_slots",
              "editor.help.bias_correction_max_interpolated_consecutive_slots"
            )}
                        ${this._renderOptionalEntityField(
              ["power_devices", "solar", "forecast", "bias_correction", "total_energy_entity_id"],
              "editor.fields.bias_correction_total_energy_entity",
              ["sensor"],
              void 0,
              "editor.help.bias_correction_total_energy_entity"
            )}
                      </div>

                      ${this._renderSectionScope(
              p.power_devices.slot_invalidation,
              s`
                          <div class="field-grid">
                            ${this._renderOptionalNumberField(
                [
                  "power_devices",
                  "solar",
                  "forecast",
                  "bias_correction",
                  "slot_invalidation",
                  "max_battery_soc_percent"
                ],
                "editor.fields.bias_correction_slot_invalidation_max_battery_soc_percent",
                "editor.helpers.bias_correction_slot_invalidation_max_battery_soc_percent",
                "editor.help.bias_correction_slot_invalidation_max_battery_soc_percent",
                { min: 0, max: 100, suffix: "%" }
              )}
                            ${this._renderOptionalEntityField(
                [
                  "power_devices",
                  "solar",
                  "forecast",
                  "bias_correction",
                  "slot_invalidation",
                  "export_enabled_entity_id"
                ],
                "editor.fields.bias_correction_slot_invalidation_export_enabled_entity_id",
                ["binary_sensor", "input_boolean", "switch"],
                void 0,
                "editor.help.bias_correction_slot_invalidation_export_enabled_entity_id"
              )}
                            ${this._renderOptionalNumberField(
                [
                  "power_devices",
                  "solar",
                  "forecast",
                  "bias_correction",
                  "slot_invalidation",
                  "data_glitch_max_slot_wh"
                ],
                "editor.fields.bias_correction_slot_invalidation_data_glitch_max_slot_wh",
                "editor.helpers.bias_correction_slot_invalidation_data_glitch_max_slot_wh",
                "editor.help.bias_correction_slot_invalidation_data_glitch_max_slot_wh",
                { min: 0, suffix: "Wh" }
              )}
                            ${this._renderOptionalNumberField(
                [
                  "power_devices",
                  "solar",
                  "forecast",
                  "bias_correction",
                  "slot_invalidation",
                  "data_glitch_min_neighbour_forecast_wh"
                ],
                "editor.fields.bias_correction_slot_invalidation_data_glitch_min_neighbour_forecast_wh",
                "editor.helpers.bias_correction_slot_invalidation_data_glitch_min_neighbour_forecast_wh",
                "editor.help.bias_correction_slot_invalidation_data_glitch_min_neighbour_forecast_wh",
                { min: 0, suffix: "Wh" }
              )}
                            ${this._renderOptionalNumberField(
                [
                  "power_devices",
                  "solar",
                  "forecast",
                  "bias_correction",
                  "slot_invalidation",
                  "data_glitch_backfill_max_minutes"
                ],
                "editor.fields.bias_correction_slot_invalidation_data_glitch_backfill_max_minutes",
                "editor.helpers.bias_correction_slot_invalidation_data_glitch_backfill_max_minutes",
                "editor.help.bias_correction_slot_invalidation_data_glitch_backfill_max_minutes",
                { min: 0, suffix: "min" }
              )}
                          </div>
                        `,
              { initialOpen: !1 }
            )}
                    `,
            { initialOpen: !1 }
          )}

                  <div class="list-card">
                    <div class="card-title" style="margin-bottom: 16px;">
                      <strong>${this._t("editor.sections.bias_correction_status")}</strong>
                      <span class="card-subtitle">${this._t("bias_correction.status_panel.subtitle")}</span>
                    </div>
                    <helman-bias-correction-status .hass=${this.hass}></helman-bias-correction-status>
                  </div>
                `,
          { initialOpen: !1 }
        )}
            `,
        { initialOpen: !1 }
      )}
        `,
      { initialOpen: !1 }
    )}

      ${this._renderSectionScope(
      p.power_devices.battery,
      s`
          <p class="inline-note">
            ${this._t("editor.notes.battery_entities")}
          </p>
          <div class="field-grid field-grid--roomy">
            ${this._renderOptionalEntityField(
        ["power_devices", "battery", "entities", "power"],
        "editor.fields.power_entity",
        ["sensor"],
        void 0,
        "editor.help.battery_power_entity"
      )}
            ${this._renderOptionalEntityField(
        ["power_devices", "battery", "entities", "remaining_energy"],
        "editor.fields.remaining_energy_entity",
        ["sensor"],
        void 0,
        "editor.help.battery_remaining_energy_entity"
      )}
            ${this._renderOptionalEntityField(
        ["power_devices", "battery", "entities", "capacity"],
        "editor.fields.capacity_entity",
        ["sensor"],
        void 0,
        "editor.help.battery_capacity_entity"
      )}
            ${this._renderOptionalEntityField(
        ["power_devices", "battery", "entities", "min_soc"],
        "editor.fields.min_soc_entity",
        ["sensor"],
        void 0,
        "editor.help.battery_min_soc_entity"
      )}
            ${this._renderOptionalEntityField(
        ["power_devices", "battery", "entities", "max_soc"],
        "editor.fields.max_soc_entity",
        ["sensor"],
        void 0,
        "editor.help.battery_max_soc_entity"
      )}
          </div>
          <div class="field-grid">
            ${this._renderOptionalNumberField(
        ["power_devices", "battery", "forecast", "charge_efficiency"],
        "editor.fields.charge_efficiency",
        void 0,
        "editor.help.battery_charge_efficiency"
      )}
            ${this._renderOptionalNumberField(
        ["power_devices", "battery", "forecast", "discharge_efficiency"],
        "editor.fields.discharge_efficiency",
        void 0,
        "editor.help.battery_discharge_efficiency"
      )}
            ${this._renderOptionalNumberField(
        ["power_devices", "battery", "forecast", "max_charge_power_w"],
        "editor.fields.max_charge_power_w",
        void 0,
        "editor.help.battery_max_charge_power_w"
      )}
            ${this._renderOptionalNumberField(
        ["power_devices", "battery", "forecast", "max_discharge_power_w"],
        "editor.fields.max_discharge_power_w",
        void 0,
        "editor.help.battery_max_discharge_power_w"
      )}
          </div>
        `,
      { initialOpen: !1 }
    )}

      ${this._renderSectionScope(
      p.power_devices.grid,
      s`
          <div class="field-grid">
            ${this._renderOptionalEntityField(
        ["power_devices", "grid", "entities", "power"],
        "editor.fields.power_entity",
        ["sensor"],
        void 0,
        "editor.help.grid_power_entity"
      )}
            ${this._renderOptionalEntityField(
        ["power_devices", "grid", "forecast", "sell_price_entity_id"],
        "editor.fields.sell_price_entity",
        ["sensor"],
        void 0,
        "editor.help.grid_sell_price_entity"
      )}
            ${this._renderOptionalTextField(
        ["power_devices", "grid", "forecast", "import_price_unit"],
        "editor.fields.import_price_unit",
        "editor.helpers.import_price_unit",
        "editor.help.grid_import_price_unit"
      )}
          </div>

          <p class="inline-note">
            ${this._t("editor.notes.grid_import_windows")}
          </p>
          <div class="list-stack">
            ${i.map(
        (d, c) => this._renderImportPriceWindow(d, c, i.length)
      )}
          </div>
          <div class="section-footer">
            <button type="button" class="add-button" @click=${this._handleAddImportPriceWindow}>
              ${this._t("editor.actions.add_import_price_window")}
            </button>
          </div>
        `,
      { initialOpen: !1 }
    )}
    `;
  }
  _renderSchedulerTab() {
    return s`
      ${this._renderSectionScope(
      p.scheduler.schedule_control_mapping,
      s`
          <div class="field-grid">
            ${this._renderRequiredEntityField(
        ["scheduler", "control", "mode_entity_id"],
        "editor.fields.mode_entity",
        ["input_select", "select"],
        "editor.helpers.mode_entity",
        void 0,
        "editor.help.scheduler_mode_entity"
      )}
            ${this._renderOptionalTextField(
        ["scheduler", "control", "action_option_map", "normal"],
        "editor.fields.normal_option",
        void 0,
        "editor.help.scheduler_action_option"
      )}
            ${this._renderOptionalTextField(
        ["scheduler", "control", "action_option_map", "charge_to_target_soc"],
        "editor.fields.charge_to_target_soc_option",
        void 0,
        "editor.help.scheduler_action_option"
      )}
            ${this._renderOptionalTextField(
        ["scheduler", "control", "action_option_map", "discharge_to_target_soc"],
        "editor.fields.discharge_to_target_soc_option",
        void 0,
        "editor.help.scheduler_action_option"
      )}
            ${this._renderOptionalTextField(
        ["scheduler", "control", "action_option_map", "stop_charging"],
        "editor.fields.stop_charging_option",
        void 0,
        "editor.help.scheduler_action_option"
      )}
            ${this._renderOptionalTextField(
        ["scheduler", "control", "action_option_map", "stop_discharging"],
        "editor.fields.stop_discharging_option",
        void 0,
        "editor.help.scheduler_action_option"
      )}
            ${this._renderOptionalTextField(
        ["scheduler", "control", "action_option_map", "stop_export"],
        "editor.fields.stop_export_option",
        void 0,
        "editor.help.scheduler_action_option"
      )}
          </div>
        `
    )}
    `;
  }
  _renderAutomationTab() {
    const e = $(this._getValue(["automation", "optimizers"])) ?? [];
    return s`
      ${this._renderSectionScope(
      p.automation.settings,
      s`
          <p class="inline-note">
            ${this._t("editor.notes.automation")}
          </p>
          <div class="field-grid">
            ${this._renderAutomationEnabledField()}
          </div>
        `
    )}

      ${this._renderSectionScope(
      p.automation.optimizer_pipeline,
      s`
          <p class="inline-note">
            ${this._t("editor.notes.optimizer_pipeline")}
          </p>
          <div class="list-stack">
            ${e.map(
        (t, i) => this._renderAutomationOptimizerCard(t, i, e.length)
      )}
          </div>
          ${e.length === 0 ? s`
                <div class="message info">
                  ${this._t("editor.empty.no_automation_optimizers")}
                </div>
              ` : u}
          <div class="section-footer">
            <button type="button" class="add-button" @click=${this._handleAddExportPriceOptimizer}>
              ${this._t("editor.actions.add_export_price_optimizer")}
            </button>
            <button
              type="button"
              class="add-button"
              @click=${this._handleAddSurplusApplianceOptimizer}
            >
              ${this._t("editor.actions.add_surplus_appliance_optimizer")}
            </button>
          </div>
        `
    )}
    `;
  }
  _renderAutomationOptimizerCard(e, t, i) {
    const o = y(e) ?? {}, r = this._stringValue(o.kind);
    return r === Ri ? this._renderExportPriceOptimizerCard(o, t, i) : r === et ? this._renderSurplusApplianceOptimizerCard(o, t, i) : this._renderUnsupportedAutomationOptimizerCard(o, t, i);
  }
  _renderAutomationEnabledField() {
    const e = this._getAutomationEnabled();
    return s`
      <div class="field toggle-field">
        <ha-formfield .label=${this._t("editor.fields.automation_enabled")}>
          <ha-switch
            .checked=${e}
            @change=${(t) => this._setAutomationEnabled(
      t.currentTarget.checked
    )}
          ></ha-switch>
        </ha-formfield>
        <div class="helper">${this._t("editor.helpers.automation_enabled")}</div>
      </div>
    `;
  }
  _renderExportPriceOptimizerCard(e, t, i) {
    const o = ["automation", "optimizers", t], r = [...o, "params"], n = this._booleanValue(this._getValue([...o, "enabled"]), !0), l = this._stringValue(e.id) || this._tFormat("editor.dynamic.optimizer", { index: t + 1 }), d = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z", c = this._stringValue(this._getValue([...r, "action"])) || Fi, h = this._getValue([...r, "when_price_below"]) ?? 0;
    return s`
      <details class=${`list-card optimizer-card optimizer-card--${n ? "enabled" : "disabled"}`}>
        <summary>
          <div class="appliance-summary-row">
            <div class="appliance-summary-left">
              ${this._renderSvgIcon(d, "appliance-chevron")}
              <div class="card-title">
                <strong>${l}</strong>
                <span class="card-subtitle">${this._t("editor.values.export_price")}</span>
              </div>
            </div>
            <div class="list-actions" @click=${this._preventSummaryToggle}>
              ${this._renderOptimizerEnabledToggle([...o, "enabled"], n)}
              <button
                type="button"
                ?disabled=${t === 0}
                @click=${() => this._moveListItem(["automation", "optimizers"], t, t - 1)}
              >${this._t("editor.actions.up")}</button>
              <button
                type="button"
                ?disabled=${t === i - 1}
                @click=${() => this._moveListItem(["automation", "optimizers"], t, t + 1)}
              >${this._t("editor.actions.down")}</button>
              <button
                type="button"
                class="danger"
                @click=${() => this._removeListItem(["automation", "optimizers"], t)}
              >${this._t("editor.actions.remove")}</button>
            </div>
          </div>
        </summary>
        <div class="appliance-body">
          <div class="field-grid">
            ${this._renderRequiredTextField(
      [...o, "id"],
      "editor.fields.optimizer_id",
      void 0,
      "editor.help.automation_optimizer_id"
    )}
            ${this._renderRequiredNumberField(
      [...r, "when_price_below"],
      "editor.fields.when_price_below",
      h,
      "any",
      "editor.help.export_price_when_price_below"
    )}
            <div class="field">
              <div class="field-label-row">
                <label>${this._t("editor.fields.optimizer_action")}</label>
                ${this._renderHelpIcon(
      "editor.fields.optimizer_action",
      "editor.help.export_price_action"
    )}
              </div>
              <input .value=${c} disabled />
              <div class="helper">${this._t("editor.helpers.export_price_action")}</div>
            </div>
          </div>
        </div>
      </details>
    `;
  }
  _renderSurplusApplianceOptimizerCard(e, t, i) {
    const o = ["automation", "optimizers", t], r = [...o, "params"], n = this._booleanValue(this._getValue([...o, "enabled"]), !0), l = this._stringValue(e.id) || this._tFormat("editor.dynamic.optimizer", { index: t + 1 }), d = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z", c = this._stringValue(this._getValue([...r, "appliance_id"])), h = this._stringValue(this._getValue([...r, "action"])) || Di, _ = this._getValue([...r, "min_surplus_buffer_pct"]) ?? 5, m = ue(
      this._config,
      this._liveApplianceMetadata,
      c
    ), b = he(
      m,
      this._stringValue(this._getValue([...r, "climate_mode"]))
    ), N = this._getSurplusApplianceOptimizerTitle(m, l);
    return s`
      <details class=${`list-card optimizer-card optimizer-card--${n ? "enabled" : "disabled"}`}>
        <summary>
          <div class="appliance-summary-row">
            <div class="appliance-summary-left">
              ${this._renderSvgIcon(d, "appliance-chevron")}
              <div class="card-title">
                <strong>${N}</strong>
                <span class="card-subtitle">${this._t("editor.values.surplus_appliance")}</span>
              </div>
            </div>
            <div class="list-actions" @click=${this._preventSummaryToggle}>
              ${this._renderOptimizerEnabledToggle([...o, "enabled"], n)}
              <button
                type="button"
                ?disabled=${t === 0}
                @click=${() => this._moveListItem(["automation", "optimizers"], t, t - 1)}
              >${this._t("editor.actions.up")}</button>
              <button
                type="button"
                ?disabled=${t === i - 1}
                @click=${() => this._moveListItem(["automation", "optimizers"], t, t + 1)}
              >${this._t("editor.actions.down")}</button>
              <button
                type="button"
                class="danger"
                @click=${() => this._removeListItem(["automation", "optimizers"], t)}
              >${this._t("editor.actions.remove")}</button>
            </div>
          </div>
        </summary>
        <div class="appliance-body">
          <div class="field-grid">
            ${this._renderRequiredTextField(
      [...o, "id"],
      "editor.fields.optimizer_id",
      void 0,
      "editor.help.automation_optimizer_id"
    )}
            <div class="field">
              <div class="field-label-row">
                <label>${this._t("editor.fields.appliance_id")}</label>
                ${this._renderHelpIcon("editor.fields.appliance_id", "editor.help.surplus_appliance_id")}
              </div>
              <select
                @change=${(R) => this._handleSurplusApplianceIdChange(
      t,
      R.currentTarget.value
    )}
              >
                <option value="" ?selected=${m.selectedId.length === 0}>
                  ${this._t("editor.values.select_appliance")}
                </option>
                ${m.selectedMissingFromDraft && m.selectedId.length > 0 ? s`
                      <option
                        value=${m.selectedId}
                        ?selected=${!0}
                      >
                        ${this._tFormat("editor.dynamic.stale_appliance", {
      id: m.selectedId
    })}
                      </option>
                    ` : u}
                ${m.options.map(
      (R) => s`
                    <option
                      value=${R.id}
                      ?disabled=${R.selectionDisabled}
                      ?selected=${R.id === m.selectedId}
                    >
                      ${this._formatSurplusApplianceOptionLabel(R)}
                    </option>
                  `
    )}
              </select>
              <div class="helper">
                ${this._renderSurplusApplianceIdHelper(m)}
              </div>
            </div>
            ${this._renderRequiredNumberField(
      [...r, "min_surplus_buffer_pct"],
      "editor.fields.min_surplus_buffer_pct",
      _,
      "1",
      "editor.help.surplus_appliance_min_surplus_buffer_pct"
    )}
            ${b.visible ? this._renderSurplusClimateModeField(r, b) : this._renderSurplusApplianceActionField(h)}
          </div>
        </div>
      </details>
    `;
  }
  _renderUnsupportedAutomationOptimizerCard(e, t, i) {
    const o = ["automation", "optimizers", t], r = this._booleanValue(this._getValue([...o, "enabled"]), !0), n = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z", l = this._stringValue(e.id) || this._tFormat("editor.dynamic.optimizer", { index: t + 1 }), d = this._tFormat("editor.dynamic.unsupported_optimizer_kind", {
      kind: this._stringValue(e.kind) || this._t("editor.values.unknown")
    });
    return s`
      <details class=${`list-card optimizer-card optimizer-card--${r ? "enabled" : "disabled"}`}>
        <summary>
          <div class="appliance-summary-row">
            <div class="appliance-summary-left">
              ${this._renderSvgIcon(n, "appliance-chevron")}
              <div class="card-title">
                <strong>${l}</strong>
                <span class="card-subtitle">${d}</span>
              </div>
            </div>
            <div class="list-actions" @click=${this._preventSummaryToggle}>
              ${this._renderOptimizerEnabledToggle([...o, "enabled"], r)}
              <button
                type="button"
                ?disabled=${t === 0}
                @click=${() => this._moveListItem(["automation", "optimizers"], t, t - 1)}
              >${this._t("editor.actions.up")}</button>
              <button
                type="button"
                ?disabled=${t === i - 1}
                @click=${() => this._moveListItem(["automation", "optimizers"], t, t + 1)}
              >${this._t("editor.actions.down")}</button>
              <button
                type="button"
                class="danger"
                @click=${() => this._removeListItem(["automation", "optimizers"], t)}
              >${this._t("editor.actions.remove")}</button>
            </div>
          </div>
        </summary>
        <div class="appliance-body">
          <pre class="raw-preview">${JSON.stringify(e, null, 2)}</pre>
        </div>
      </details>
    `;
  }
  _renderOptimizerEnabledToggle(e, t) {
    return s`
      <div class="summary-toggle" @click=${this._stopSummaryToggle}>
        <span>${this._t("editor.fields.optimizer_enabled")}</span>
        <ha-switch
          .checked=${t}
          @change=${(i) => this._setBoolean(
      e,
      i.currentTarget.checked
    )}
        ></ha-switch>
      </div>
    `;
  }
  _renderAppliancesTab() {
    const e = $(this._getValue(["appliances"])) ?? [];
    return s`
      ${this._renderSectionScope(
      p.appliances.configured_appliances,
      s`
          <p class="inline-note">
            ${this._t("editor.notes.appliances")}
          </p>
          <div class="list-stack">
            ${e.length === 0 ? s`<div class="message info">${this._t("editor.empty.no_appliances")}</div>` : e.map(
        (t, i) => this._renderApplianceCard(t, i, e.length)
      )}
          </div>
          <div class="section-footer">
            <button type="button" class="add-button primary" @click=${this._handleAddEvCharger}>
              ${this._t("editor.actions.add_ev_charger")}
            </button>
            <button
              type="button"
              class="add-button"
              @click=${this._handleAddClimateAppliance}
            >
              ${this._t("editor.actions.add_climate_appliance")}
            </button>
            <button
              type="button"
              class="add-button"
              @click=${this._handleAddGenericAppliance}
            >
              ${this._t("editor.actions.add_generic_appliance")}
            </button>
          </div>
        `
    )}
    `;
  }
  _renderDeviceLabelCategories() {
    const e = M(this._getValue(["device_label_text"]));
    return e.length === 0 ? [s`<div class="message info">${this._t("editor.empty.no_device_label_categories")}</div>`] : e.map(([t, i]) => {
      const o = M(i);
      return s`
        <div class="list-card">
          <div class="card-header">
            <div class="card-title">
              <strong>${t}</strong>
              <span class="card-subtitle">${this._t("editor.card.category")}</span>
            </div>
            <div class="inline-actions">
              <button
                type="button"
                class="danger"
                @click=${() => this._removePath(["device_label_text", t])}
              >
                ${this._t("editor.actions.remove_category")}
              </button>
            </div>
          </div>
          <div class="field-grid">
            <div class="field">
              <label>${this._t("editor.fields.category_key")}</label>
              <input
                .value=${t}
                @change=${(r) => {
        this._handleRenameObjectKey(
          ["device_label_text"],
          t,
          r.currentTarget.value
        );
      }}
              />
            </div>
          </div>
          <div class="list-stack">
            ${o.map(([r, n]) => s`
              <div class="nested-card">
                <div class="card-header">
                  <div class="card-title">
                    <strong>${r}</strong>
                    <span class="card-subtitle">${this._t("editor.card.badge_text_entry")}</span>
                  </div>
                  <div class="inline-actions">
                    <button
                      type="button"
                      class="danger"
                      @click=${() => this._removePath(["device_label_text", t, r])}
                    >
                      ${this._t("editor.actions.remove")}
                    </button>
                  </div>
                </div>
                <div class="field-grid">
                  <div class="field">
                    <label>${this._t("editor.fields.label_key")}</label>
                    <input
                      .value=${r}
                      @change=${(l) => {
        this._handleRenameObjectKey(
          ["device_label_text", t],
          r,
          l.currentTarget.value
        );
      }}
                    />
                  </div>
                  <div class="field">
                    <label>${this._t("editor.fields.badge_text")}</label>
                    <input
                      .value=${this._stringValue(n)}
                      @change=${(l) => {
        this._setRequiredString(
          ["device_label_text", t, r],
          l.currentTarget.value
        );
      }}
                    />
                  </div>
                </div>
              </div>
            `)}
          </div>
          <div class="section-footer">
            <button
              type="button"
              class="add-button"
              @click=${() => this._handleAddDeviceLabel(t)}
            >
              ${this._t("editor.actions.add_badge_text")}
            </button>
          </div>
        </div>
      `;
    });
  }
  _renderDeferrableConsumer(e, t, i) {
    const o = y(e) ?? {}, r = [
      "power_devices",
      "house",
      "forecast",
      "deferrable_consumers",
      t
    ];
    return s`
      <div class="list-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${this._stringValue(o.label) || this._tFormat("editor.dynamic.consumer", { index: t + 1 })}</strong>
            <span class="card-subtitle">${this._t("editor.card.house_deferrable_consumer")}</span>
          </div>
          <div class="list-actions">
            <button
              type="button"
              ?disabled=${t === 0}
              @click=${() => this._moveListItem(
      ["power_devices", "house", "forecast", "deferrable_consumers"],
      t,
      t - 1
    )}
            >
              ${this._t("editor.actions.up")}
            </button>
            <button
              type="button"
              ?disabled=${t === i - 1}
              @click=${() => this._moveListItem(
      ["power_devices", "house", "forecast", "deferrable_consumers"],
      t,
      t + 1
    )}
            >
              ${this._t("editor.actions.down")}
            </button>
            <button
              type="button"
              class="danger"
              @click=${() => this._removeListItem(
      ["power_devices", "house", "forecast", "deferrable_consumers"],
      t
    )}
            >
              ${this._t("editor.actions.remove")}
            </button>
          </div>
        </div>
        <div class="field-grid">
          ${this._renderRequiredEntityField(
      [...r, "energy_entity_id"],
      "editor.fields.energy_entity",
      ["sensor"],
      void 0,
      void 0,
      "editor.help.deferrable_consumer_energy_entity"
    )}
          ${this._renderOptionalTextField([...r, "label"], "editor.fields.label")}
        </div>
      </div>
    `;
  }
  _renderDailyEnergyEntity(e, t, i) {
    const o = [
      "power_devices",
      "solar",
      "forecast",
      "daily_energy_entity_ids",
      t
    ];
    return s`
      <div class="list-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${this._tFormat("editor.dynamic.daily_energy_entity", { index: t + 1 })}</strong>
          </div>
          <div class="list-actions">
            <button
              type="button"
              ?disabled=${t === 0}
              @click=${() => this._moveListItem(
      ["power_devices", "solar", "forecast", "daily_energy_entity_ids"],
      t,
      t - 1
    )}
            >
              ${this._t("editor.actions.up")}
            </button>
            <button
              type="button"
              ?disabled=${t === i - 1}
              @click=${() => this._moveListItem(
      ["power_devices", "solar", "forecast", "daily_energy_entity_ids"],
      t,
      t + 1
    )}
            >
              ${this._t("editor.actions.down")}
            </button>
            <button
              type="button"
              class="danger"
              @click=${() => this._removeListItem(
      ["power_devices", "solar", "forecast", "daily_energy_entity_ids"],
      t
    )}
            >
              ${this._t("editor.actions.remove")}
            </button>
          </div>
        </div>
        ${this._renderRequiredEntityField(o, "editor.fields.entity_id", ["sensor"], void 0, e, "editor.help.solar_daily_energy_entity")}
      </div>
    `;
  }
  _renderImportPriceWindow(e, t, i) {
    const o = y(e) ?? {}, r = [
      "power_devices",
      "grid",
      "forecast",
      "import_price_windows",
      t
    ];
    return s`
      <div class="list-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${this._tFormat("editor.dynamic.import_window", { index: t + 1 })}</strong>
            <span class="card-subtitle">${this._t("editor.card.local_time_window")}</span>
          </div>
          <div class="list-actions">
            <button
              type="button"
              ?disabled=${t === 0}
              @click=${() => this._moveListItem(
      ["power_devices", "grid", "forecast", "import_price_windows"],
      t,
      t - 1
    )}
            >
              ${this._t("editor.actions.up")}
            </button>
            <button
              type="button"
              ?disabled=${t === i - 1}
              @click=${() => this._moveListItem(
      ["power_devices", "grid", "forecast", "import_price_windows"],
      t,
      t + 1
    )}
            >
              ${this._t("editor.actions.down")}
            </button>
            <button
              type="button"
              class="danger"
              @click=${() => this._removeListItem(
      ["power_devices", "grid", "forecast", "import_price_windows"],
      t
    )}
            >
              ${this._t("editor.actions.remove")}
            </button>
          </div>
        </div>
        <div class="field-grid">
          <div class="field">
            <div class="field-label-row">
              <label>${this._t("editor.fields.start")}</label>
              ${this._renderHelpIcon("editor.fields.start", "editor.help.import_window_start")}
            </div>
            <input
              type="time"
              .value=${this._stringValue(o.start)}
              @change=${(n) => this._setRequiredString(
      [...r, "start"],
      n.currentTarget.value
    )}
            />
          </div>
          <div class="field">
            <div class="field-label-row">
              <label>${this._t("editor.fields.end")}</label>
              ${this._renderHelpIcon("editor.fields.end", "editor.help.import_window_end")}
            </div>
            <input
              type="time"
              .value=${this._stringValue(o.end)}
              @change=${(n) => this._setRequiredString(
      [...r, "end"],
      n.currentTarget.value
    )}
            />
          </div>
          ${this._renderRequiredNumberField([...r, "price"], "editor.fields.price", void 0, "any", "editor.help.import_window_price")}
        </div>
      </div>
    `;
  }
  _renderApplianceCard(e, t, i) {
    const o = y(e) ?? {}, r = this._stringValue(o.kind);
    return r === "ev_charger" ? this._renderEvChargerAppliance(o, t, i) : r === "climate" ? this._renderClimateAppliance(o, t, i) : r === "generic" ? this._renderGenericAppliance(o, t, i) : this._renderUnsupportedAppliance(o, t, i);
  }
  _renderUnsupportedAppliance(e, t, i) {
    const o = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z", r = this._stringValue(e.name) || this._tFormat("editor.dynamic.appliance", { index: t + 1 }), n = this._tFormat("editor.dynamic.unsupported_appliance_kind", {
      kind: this._stringValue(e.kind) || this._t("editor.values.unknown")
    });
    return s`
      <details class="list-card">
        <summary>
          <div class="appliance-summary-row">
            <div class="appliance-summary-left">
              ${this._renderSvgIcon(o, "appliance-chevron")}
              <div class="card-title">
                <strong>${r}</strong>
                <span class="card-subtitle">${n}</span>
              </div>
            </div>
            <div class="list-actions" @click=${this._preventSummaryToggle}>
              <button
                type="button"
                ?disabled=${t === 0}
                @click=${() => this._moveListItem(["appliances"], t, t - 1)}
              >${this._t("editor.actions.up")}</button>
              <button
                type="button"
                ?disabled=${t === i - 1}
                @click=${() => this._moveListItem(["appliances"], t, t + 1)}
              >${this._t("editor.actions.down")}</button>
              <button
                type="button"
                class="danger"
                @click=${() => this._removeListItem(["appliances"], t)}
              >${this._t("editor.actions.remove")}</button>
            </div>
          </div>
        </summary>
        <div class="appliance-body">
          <pre class="raw-preview">${JSON.stringify(e, null, 2)}</pre>
        </div>
      </details>
    `;
  }
  _renderEvChargerAppliance(e, t, i) {
    const o = ["appliances", t], r = M(
      this._getValue([...o, "controls", "use_mode", "values"])
    ), n = M(
      this._getValue([...o, "controls", "eco_gear", "values"])
    ), l = $(this._getValue([...o, "vehicles"])) ?? [], d = this._stringValue(e.name) || this._tFormat("editor.dynamic.ev_charger", { index: t + 1 }), c = this._stringValue(e.id) || this._t("editor.values.missing_id"), h = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z", _ = this._getApplianceMode(t) === "yaml";
    return s`
      <details class="list-card">
        <summary>
          <div class="appliance-summary-row">
            <div class="appliance-summary-left">
              ${this._renderSvgIcon(h, "appliance-chevron")}
              <div class="card-title">
                <strong>${d}</strong>
                <span class="card-subtitle">${c}</span>
              </div>
            </div>
            <div class="list-actions" @click=${this._preventSummaryToggle}>
              ${this._renderApplianceModeToggle(t)}
              <button type="button" ?disabled=${t === 0}
                @click=${() => this._moveListItem(["appliances"], t, t - 1)}
              >${this._t("editor.actions.up")}</button>
              <button type="button" ?disabled=${t === i - 1}
                @click=${() => this._moveListItem(["appliances"], t, t + 1)}
              >${this._t("editor.actions.down")}</button>
              <button type="button" class="danger"
                @click=${() => this._removeListItem(["appliances"], t)}
              >${this._t("editor.actions.remove")}</button>
            </div>
          </div>
        </summary>
        <div class="appliance-body">
          ${_ ? this._renderApplianceYamlEditor(t) : s`
              ${this._renderSimpleSection(
      this._t("editor.sections.identity_and_limits"),
      s`<div class="field-grid">
                  ${this._renderRequiredTextField([...o, "id"], "editor.fields.appliance_id", void 0, "editor.help.appliance_id")}
                  ${this._renderRequiredTextField([...o, "name"], "editor.fields.appliance_name", void 0, "editor.help.appliance_name")}
                  ${this._renderOptionalIconField([...o, "icon"], "editor.fields.appliance_icon", "editor.helpers.appliance_icon")}
                  <div class="field"><label>${this._t("editor.fields.kind")}</label><input value="ev_charger" disabled /></div>
                  ${this._renderRequiredNumberField([...o, "limits", "max_charging_power_kw"], "editor.fields.max_charging_power_kw", void 0, "any", "editor.help.ev_max_charging_power_kw")}
                </div>`
    )}
              ${this._renderSimpleSection(
      this._t("editor.sections.controls"),
      s`<div class="field-grid">
                  ${this._renderRequiredEntityField([...o, "controls", "charge", "entity_id"], "editor.fields.charge_switch_entity", ["switch"], void 0, void 0, "editor.help.ev_charge_switch_entity")}
                  ${this._renderRequiredEntityField([...o, "controls", "use_mode", "entity_id"], "editor.fields.use_mode_entity", ["input_select", "select"], void 0, void 0, "editor.help.ev_use_mode_entity")}
                  ${this._renderRequiredEntityField([...o, "controls", "eco_gear", "entity_id"], "editor.fields.eco_gear_entity", ["input_select", "select"], void 0, void 0, "editor.help.ev_eco_gear_entity")}
                </div>`
    )}
              ${this._renderSimpleSection(
      this._t("editor.sections.use_modes"),
      s`<div class="list-stack">
                  ${r.map(([m, b]) => this._renderUseMode(o, m, b))}
                </div>
                <div class="section-footer">
                  <button type="button" class="add-button" @click=${() => this._handleAddUseMode(t)}>${this._t("editor.actions.add_use_mode")}</button>
                </div>`
    )}
              ${this._renderSimpleSection(
      this._t("editor.sections.eco_gears"),
      s`<div class="list-stack">
                  ${n.map(([m, b]) => this._renderEcoGear(o, m, b))}
                </div>
                <div class="section-footer">
                  <button type="button" class="add-button" @click=${() => this._handleAddEcoGear(t)}>${this._t("editor.actions.add_eco_gear")}</button>
                </div>`
    )}
              ${this._renderSimpleSection(
      this._t("editor.sections.vehicles"),
      s`<div class="list-stack">
                  ${l.map((m, b) => this._renderVehicle(o, m, b, l.length))}
                </div>
                <div class="section-footer">
                  <button type="button" class="add-button" @click=${() => this._handleAddVehicle(t)}>${this._t("editor.actions.add_vehicle")}</button>
                </div>`
    )}
            `}
        </div>
      </details>
    `;
  }
  _renderGenericAppliance(e, t, i) {
    const o = ["appliances", t], r = [...o, "projection", "history_average"], n = this._stringValue(this._getValue([...o, "projection", "strategy"])) || "fixed", l = this._stringValue(e.name) || this._tFormat("editor.dynamic.generic_appliance", { index: t + 1 }), d = this._stringValue(e.id) || this._t("editor.values.missing_id"), c = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z", h = this._getApplianceMode(t) === "yaml";
    return s`
      <details class="list-card">
        <summary>
          <div class="appliance-summary-row">
            <div class="appliance-summary-left">
              ${this._renderSvgIcon(c, "appliance-chevron")}
              <div class="card-title">
                <strong>${l}</strong>
                <span class="card-subtitle">${d}</span>
              </div>
            </div>
            <div class="list-actions" @click=${this._preventSummaryToggle}>
              ${this._renderApplianceModeToggle(t)}
              <button type="button" ?disabled=${t === 0}
                @click=${() => this._moveListItem(["appliances"], t, t - 1)}
              >${this._t("editor.actions.up")}</button>
              <button type="button" ?disabled=${t === i - 1}
                @click=${() => this._moveListItem(["appliances"], t, t + 1)}
              >${this._t("editor.actions.down")}</button>
              <button type="button" class="danger"
                @click=${() => this._removeListItem(["appliances"], t)}
              >${this._t("editor.actions.remove")}</button>
            </div>
          </div>
        </summary>
        <div class="appliance-body">
          ${h ? this._renderApplianceYamlEditor(t) : s`
              ${this._renderSimpleSection(
      this._t("editor.sections.identity_and_limits"),
      s`<div class="field-grid">
                  ${this._renderRequiredTextField([...o, "id"], "editor.fields.appliance_id", void 0, "editor.help.appliance_id")}
                  ${this._renderRequiredTextField([...o, "name"], "editor.fields.appliance_name", void 0, "editor.help.appliance_name")}
                  ${this._renderOptionalIconField([...o, "icon"], "editor.fields.appliance_icon", "editor.helpers.appliance_icon")}
                  <div class="field"><label>${this._t("editor.fields.kind")}</label><input value="generic" disabled /></div>
                </div>`
    )}
              ${this._renderSimpleSection(
      this._t("editor.sections.controls"),
      s`<div class="field-grid">
                  ${this._renderRequiredEntityField([...o, "controls", "switch", "entity_id"], "editor.fields.switch_entity", ["switch"], void 0, void 0, "editor.help.appliance_switch_entity")}
                </div>`
    )}
              ${this._renderSimpleSection(
      this._t("editor.sections.projection"),
      this._renderProjectedApplianceProjectionSection(
        o,
        n,
        r,
        "editor.notes.generic_appliance_projection",
        (_) => this._handleProjectedApplianceProjectionStrategyChange(t, _)
      )
    )}
            `}
        </div>
      </details>
    `;
  }
  _renderClimateAppliance(e, t, i) {
    const o = ["appliances", t], r = [...o, "projection", "history_average"], n = this._stringValue(this._getValue([...o, "projection", "strategy"])) || "fixed", l = this._stringValue(e.name) || this._tFormat("editor.dynamic.climate_appliance", { index: t + 1 }), d = this._stringValue(e.id) || this._t("editor.values.missing_id"), c = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z", h = this._getApplianceMode(t) === "yaml";
    return s`
      <details class="list-card">
        <summary>
          <div class="appliance-summary-row">
            <div class="appliance-summary-left">
              ${this._renderSvgIcon(c, "appliance-chevron")}
              <div class="card-title">
                <strong>${l}</strong>
                <span class="card-subtitle">${d}</span>
              </div>
            </div>
            <div class="list-actions" @click=${this._preventSummaryToggle}>
              ${this._renderApplianceModeToggle(t)}
              <button type="button" ?disabled=${t === 0}
                @click=${() => this._moveListItem(["appliances"], t, t - 1)}
              >${this._t("editor.actions.up")}</button>
              <button type="button" ?disabled=${t === i - 1}
                @click=${() => this._moveListItem(["appliances"], t, t + 1)}
              >${this._t("editor.actions.down")}</button>
              <button type="button" class="danger"
                @click=${() => this._removeListItem(["appliances"], t)}
              >${this._t("editor.actions.remove")}</button>
            </div>
          </div>
        </summary>
        <div class="appliance-body">
          ${h ? this._renderApplianceYamlEditor(t) : s`
              ${this._renderSimpleSection(
      this._t("editor.sections.identity_and_limits"),
      s`<div class="field-grid">
                  ${this._renderRequiredTextField([...o, "id"], "editor.fields.appliance_id", void 0, "editor.help.appliance_id")}
                  ${this._renderRequiredTextField([...o, "name"], "editor.fields.appliance_name", void 0, "editor.help.appliance_name")}
                  ${this._renderOptionalIconField([...o, "icon"], "editor.fields.appliance_icon", "editor.helpers.appliance_icon")}
                  <div class="field"><label>${this._t("editor.fields.kind")}</label><input value="climate" disabled /></div>
                </div>`
    )}
              ${this._renderSimpleSection(
      this._t("editor.sections.controls"),
      s`<div class="field-grid">
                  ${this._renderRequiredEntityField([...o, "controls", "climate", "entity_id"], "editor.fields.climate_entity", ["climate"], void 0, void 0, "editor.help.appliance_climate_entity")}
                </div>`
    )}
              ${this._renderSimpleSection(
      this._t("editor.sections.projection"),
      this._renderProjectedApplianceProjectionSection(
        o,
        n,
        r,
        "editor.notes.climate_appliance_projection",
        (_) => this._handleProjectedApplianceProjectionStrategyChange(t, _)
      )
    )}
            `}
        </div>
      </details>
    `;
  }
  _renderProjectedApplianceProjectionSection(e, t, i, o, r) {
    return s`
      <div class="section-content">
        <p class="inline-note">
          ${this._t(o)}
        </p>
        <div class="field-grid">
          <div class="field">
            <div class="field-label-row">
              <label>${this._t("editor.fields.projection_strategy")}</label>
              ${this._renderHelpIcon("editor.fields.projection_strategy", "editor.help.appliance_projection_strategy")}
            </div>
            <select
              .value=${t}
              @change=${(n) => r(n.currentTarget.value)}
            >
              ${Ni.map(
      (n) => s`
                  <option value=${n.value}>${this._t(n.labelKey)}</option>
                `
    )}
            </select>
          </div>
          ${this._renderRequiredNumberField(
      [...e, "projection", "hourly_energy_kwh"],
      "editor.fields.hourly_energy_kwh",
      void 0,
      "any",
      "editor.help.appliance_hourly_energy_kwh"
    )}
        </div>
        ${t === "history_average" ? s`
              <div class="field-grid">
                ${this._renderRequiredEntityField(
      [...i, "energy_entity_id"],
      "editor.fields.history_energy_entity",
      ["sensor"],
      "editor.helpers.history_energy_entity"
    )}
                ${this._renderRequiredNumberField(
      [...i, "lookback_days"],
      "editor.fields.history_lookback_days",
      void 0,
      "1",
      "editor.help.appliance_history_lookback_days"
    )}
              </div>
            ` : u}
      </div>
    `;
  }
  _renderUseMode(e, t, i) {
    const o = y(i) ?? {}, r = [
      ...e,
      "controls",
      "use_mode",
      "values"
    ];
    return s`
      <div class="nested-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${t}</strong>
            <span class="card-subtitle">${this._t("editor.card.use_mode_mapping")}</span>
          </div>
          <div class="inline-actions">
            <button
              type="button"
              class="danger"
              @click=${() => this._removePath([...r, t])}
            >
              ${this._t("editor.actions.remove")}
            </button>
          </div>
        </div>
        <div class="field-grid">
          <div class="field">
            <label>${this._t("editor.fields.mode_id")}</label>
            <input
              .value=${t}
              @change=${(n) => this._handleRenameObjectKey(
      r,
      t,
      n.currentTarget.value
    )}
            />
          </div>
          <div class="field">
            <label>${this._t("editor.fields.behavior")}</label>
            <select
              .value=${this._stringValue(o.behavior) || "fixed_max_power"}
              @change=${(n) => this._setRequiredString(
      [...r, t, "behavior"],
      n.currentTarget.value
    )}
            >
              ${Ti.map(
      (n) => s`
                  <option value=${n.value}>${this._t(n.labelKey)}</option>
                `
    )}
            </select>
          </div>
        </div>
      </div>
    `;
  }
  _renderEcoGear(e, t, i) {
    const o = y(i) ?? {}, r = [
      ...e,
      "controls",
      "eco_gear",
      "values"
    ];
    return s`
      <div class="nested-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${t}</strong>
            <span class="card-subtitle">${this._t("editor.card.eco_gear_mapping")}</span>
          </div>
          <div class="inline-actions">
            <button
              type="button"
              class="danger"
              @click=${() => this._removePath([...r, t])}
            >
              ${this._t("editor.actions.remove")}
            </button>
          </div>
        </div>
        <div class="field-grid">
          <div class="field">
            <label>${this._t("editor.fields.gear_id")}</label>
            <input
              .value=${t}
              @change=${(n) => this._handleRenameObjectKey(
      r,
      t,
      n.currentTarget.value
    )}
            />
          </div>
          ${this._renderRequiredNumberField(
      [...r, t, "min_power_kw"],
      "editor.fields.min_power_kw",
      o.min_power_kw
    )}
        </div>
      </div>
    `;
  }
  _renderVehicle(e, t, i, o) {
    const r = y(t) ?? {}, n = [...e, "vehicles", i];
    return s`
      <div class="nested-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${this._stringValue(r.name) || this._tFormat("editor.dynamic.vehicle", { index: i + 1 })}</strong>
            <span class="card-subtitle">${this._stringValue(r.id) || this._t("editor.values.missing_id")}</span>
          </div>
          <div class="list-actions">
            <button
              type="button"
              ?disabled=${i === 0}
              @click=${() => this._moveListItem([...e, "vehicles"], i, i - 1)}
            >
              ${this._t("editor.actions.up")}
            </button>
            <button
              type="button"
              ?disabled=${i === o - 1}
              @click=${() => this._moveListItem([...e, "vehicles"], i, i + 1)}
            >
              ${this._t("editor.actions.down")}
            </button>
            <button
              type="button"
              class="danger"
              @click=${() => this._removeListItem([...e, "vehicles"], i)}
            >
              ${this._t("editor.actions.remove")}
            </button>
          </div>
        </div>
        <div class="field-grid">
          ${this._renderRequiredTextField([...n, "id"], "editor.fields.vehicle_id", void 0, "editor.help.vehicle_id")}
          ${this._renderRequiredTextField([...n, "name"], "editor.fields.vehicle_name")}
          ${this._renderRequiredEntityField(
      [...n, "telemetry", "soc_entity_id"],
      "editor.fields.soc_entity",
      ["sensor"],
      void 0,
      void 0,
      "editor.help.vehicle_soc_entity"
    )}
          ${this._renderOptionalEntityField(
      [...n, "telemetry", "charge_limit_entity_id"],
      "editor.fields.charge_limit_entity",
      ["number"],
      void 0,
      "editor.help.vehicle_charge_limit_entity"
    )}
          ${this._renderRequiredNumberField(
      [...n, "limits", "battery_capacity_kwh"],
      "editor.fields.battery_capacity_kwh",
      void 0,
      "any",
      "editor.help.vehicle_battery_capacity_kwh"
    )}
          ${this._renderRequiredNumberField(
      [...n, "limits", "max_charging_power_kw"],
      "editor.fields.max_charging_power_kw",
      void 0,
      "any",
      "editor.help.vehicle_max_charging_power_kw"
    )}
        </div>
      </div>
    `;
  }
  _renderOptionalTextField(e, t, i, o) {
    return s`
      <div class="field">
        <div class="field-label-row">
          <label>${this._t(t)}</label>
          ${o ? this._renderHelpIcon(t, o) : u}
        </div>
        <input
          .value=${this._stringValue(this._getValue(e))}
          @change=${(r) => this._setOptionalString(e, r.currentTarget.value)}
        />
        ${i ? s`<div class="helper">${this._t(i)}</div>` : u}
      </div>
    `;
  }
  _renderRequiredTextField(e, t, i, o) {
    const r = i === void 0 ? this._getValue(e) : i;
    return s`
      <div class="field">
        <div class="field-label-row">
          <label>${this._t(t)}</label>
          ${o ? this._renderHelpIcon(t, o) : u}
        </div>
        <input
          .value=${this._stringValue(r)}
          @change=${(n) => this._setRequiredString(e, n.currentTarget.value)}
        />
      </div>
    `;
  }
  _renderOptionalNumberField(e, t, i, o, r = {}) {
    return s`
      <div class="field">
        <div class="field-label-row">
          <label>${this._t(t)}</label>
          ${o ? this._renderHelpIcon(t, o) : u}
        </div>
        <div class="number-input-wrap">
          <input
            type="number"
            step="any"
            min=${r.min ?? u}
            max=${r.max ?? u}
            .value=${this._stringValue(this._getValue(e))}
            @change=${(n) => this._setOptionalNumber(e, n.currentTarget.value)}
          />
          ${r.suffix ? s`<span class="number-input-suffix">${r.suffix}</span>` : u}
        </div>
        ${i ? s`<div class="helper">${this._t(i)}</div>` : u}
      </div>
    `;
  }
  _renderRequiredNumberField(e, t, i, o = "any", r) {
    const n = i === void 0 ? this._getValue(e) : i;
    return s`
      <div class="field">
        <div class="field-label-row">
          <label>${this._t(t)}</label>
          ${r ? this._renderHelpIcon(t, r) : u}
        </div>
        <input
          type="number"
          .step=${o}
          .value=${this._stringValue(n)}
          @change=${(l) => this._setRequiredNumber(e, l.currentTarget.value)}
        />
      </div>
    `;
  }
  _renderOptionalSelectField(e, t, i, o) {
    const r = this._stringValue(this._getValue(e));
    return s`
      <div class="field">
        <div class="field-label-row">
          <label>${this._t(t)}</label>
          ${o ? this._renderHelpIcon(t, o) : u}
        </div>
        <select
          .value=${r}
          @change=${(n) => this._setOptionalString(e, n.currentTarget.value)}
        >
          <option value=""></option>
          ${i.map(
      (n) => s`
              <option value=${n.value} ?selected=${n.value === r}>${n.label}</option>
            `
    )}
        </select>
      </div>
    `;
  }
  _renderOptionalIconField(e, t, i) {
    return s`
      <div class="field">
        <ha-selector
          .hass=${this.hass}
          .narrow=${this.narrow ?? !1}
          .selector=${Yi}
          .label=${this._t(t)}
          .helper=${i ? this._t(i) : void 0}
          .required=${!1}
          .value=${this._stringValue(this._getValue(e))}
          @value-changed=${(o) => {
      var n;
      const r = ((n = o.detail) == null ? void 0 : n.value) ?? "";
      this._setOptionalString(e, r);
    }}
        ></ha-selector>
      </div>
    `;
  }
  _renderBooleanField(e, t, i) {
    const o = this._booleanValue(this._getValue(e), i);
    return s`
      <div class="field toggle-field">
        <ha-formfield .label=${this._t(t)}>
          <ha-switch
            .checked=${o}
            @change=${(r) => this._setBoolean(
      e,
      r.currentTarget.checked
    )}
          ></ha-switch>
        </ha-formfield>
      </div>
    `;
  }
  _renderOptionalEntityField(e, t, i, o, r) {
    return this._renderEntityField(
      e,
      t,
      i,
      o,
      !1,
      this._getValue(e),
      r
    );
  }
  _renderRequiredEntityField(e, t, i, o, r, n) {
    return this._renderEntityField(
      e,
      t,
      i,
      o,
      !0,
      r === void 0 ? this._getValue(e) : r,
      n
    );
  }
  _renderEntityField(e, t, i, o, r, n, l) {
    return s`
      <div class="field">
        <div class="field-label-row">
          <label>${this._t(t)}</label>
          ${l ? this._renderHelpIcon(t, l) : u}
        </div>
        <ha-entity-picker
          .hass=${this.hass}
          .value=${this._stringValue(n)}
          .includeDomains=${i}
          @value-changed=${(d) => {
      var h;
      const c = ((h = d.detail) == null ? void 0 : h.value) ?? "";
      r ? this._setRequiredString(e, c) : this._setOptionalString(e, c);
    }}
        ></ha-entity-picker>
        ${o ? s`<div class="helper">${this._t(o)}</div>` : u}
      </div>
    `;
  }
  _renderHelpIcon(e, t) {
    return s`
      <button
        type="button"
        class="help-btn"
        aria-label=${this._t("editor.help.aria_label")}
        @click=${(i) => {
      i.stopPropagation(), this._helpDialog = { labelKey: e, contentKey: t };
    }}
      >?</button>
    `;
  }
  _renderHelpDialog() {
    if (!this._helpDialog)
      return u;
    const { labelKey: e, contentKey: t } = this._helpDialog;
    return s`
      <div class="help-overlay" @click=${this._closeHelp}>
        <div class="help-dialog" @click=${(i) => i.stopPropagation()}>
          <div class="help-dialog-header">
            <strong>${this._t(e)}</strong>
            <button
              type="button"
              class="help-dialog-close"
              aria-label=${this._t("editor.help.close")}
              @click=${this._closeHelp}
            >✕</button>
          </div>
          <p class="help-dialog-body">${this._t(t)}</p>
        </div>
      </div>
    `;
  }
  _renderIssueBoard() {
    if (!this._validation)
      return u;
    const e = [
      { title: this._t("editor.issues.errors"), items: this._validation.errors },
      { title: this._t("editor.issues.warnings"), items: this._validation.warnings }
    ].filter((t) => t.items.length > 0);
    return e.length === 0 ? u : s`
      <div class="issue-board">
        ${e.map(
      (t) => s`
            <div class="issue-group">
              <h3>${t.title}</h3>
              <ul>
                ${t.items.map(
        (i) => s`
                    <li>
                      <div class="issue-path">${i.path}</div>
                      <div>${i.message}</div>
                    </li>
                  `
      )}
              </ul>
            </div>
          `
    )}
      </div>
    `;
  }
  _buildTabIssueCounts() {
    const e = {
      general: { errors: 0, warnings: 0 },
      power_devices: { errors: 0, warnings: 0 },
      scheduler: { errors: 0, warnings: 0 },
      automation: { errors: 0, warnings: 0 },
      appliances: { errors: 0, warnings: 0 }
    };
    if (this._validation) {
      for (const t of this._validation.errors) {
        const i = qe[t.section] ?? "general";
        e[i].errors += 1;
      }
      for (const t of this._validation.warnings) {
        const i = qe[t.section] ?? "general";
        e[i].warnings += 1;
      }
    }
    for (const t of Object.keys(this._scopeYamlErrors)) {
      if (!this._scopeYamlErrors[t])
        continue;
      const i = Z(t).tabId;
      i && (e[i].warnings += 1);
    }
    return e;
  }
  async _loadConfig(e) {
    if (this.hass) {
      this._loading = !0;
      try {
        const [t, i] = await Promise.allSettled([
          this.hass.callWS({ type: "helman/get_config" }),
          this._loadLiveApplianceMetadata()
        ]);
        if (t.status !== "fulfilled")
          throw t.reason;
        const o = y(t.value);
        this._config = o ? w(o) : {}, this._liveApplianceMetadata = i.status === "fulfilled" ? i.value : null, this._validation = null, this._dirty = this._config ? this._normalizeSurplusApplianceOptimizerParams(this._config) : !1, this._resetScopeYamlState(), e.showMessage && (this._message = {
          kind: "info",
          text: this._t("editor.messages.reloaded_config")
        });
      } catch (t) {
        this._liveApplianceMetadata = null, this._message = {
          kind: "error",
          text: this._formatError(t, this._t("editor.messages.load_config_failed"))
        };
      } finally {
        this._loading = !1;
      }
    }
  }
  async _validateConfig() {
    if (!(!this.hass || !this._config)) {
      if (this._hasBlockingYamlErrors()) {
        this._message = {
          kind: "error",
          text: this._t("editor.messages.fix_yaml_errors_first")
        };
        return;
      }
      this._validating = !0;
      try {
        const e = await this.hass.callWS({
          type: "helman/validate_config",
          config: this._config
        });
        this._validation = e, this._message = e.valid ? { kind: "success", text: this._t("editor.messages.validation_passed") } : {
          kind: "error",
          text: this._t("editor.messages.validation_failed")
        };
      } catch (e) {
        this._message = {
          kind: "error",
          text: this._formatError(e, this._t("editor.messages.validate_config_failed"))
        };
      } finally {
        this._validating = !1;
      }
    }
  }
  async _saveConfig() {
    if (!(!this.hass || !this._config)) {
      if (this._hasBlockingYamlErrors()) {
        this._message = {
          kind: "error",
          text: this._t("editor.messages.fix_yaml_errors_first")
        };
        return;
      }
      this._saving = !0;
      try {
        const e = await this.hass.callWS({
          type: "helman/save_config",
          config: this._config
        });
        if (this._validation = e.validation, e.success) {
          this._liveApplianceMetadata = await this._loadLiveApplianceMetadata(), this._dirty = this._config ? this._normalizeSurplusApplianceOptimizerParams(this._config) : !1, this._message = {
            kind: "success",
            text: e.reloadStarted ? this._t("editor.messages.config_saved_reload_started") : this._t("editor.messages.config_saved")
          };
          return;
        }
        this._message = {
          kind: "error",
          text: e.reloadError ?? (e.validation.valid ? this._t("editor.messages.config_saved_reload_failed") : this._t("editor.messages.save_rejected"))
        };
      } catch (e) {
        this._message = {
          kind: "error",
          text: this._formatError(e, this._t("editor.messages.save_failed"))
        };
      } finally {
        this._saving = !1;
      }
    }
  }
  _handleScopeModeSelection(e, t, i) {
    if (i.preventDefault(), i.stopPropagation(), t === "yaml") {
      this._enterYamlMode(e);
      return;
    }
    this._exitYamlMode(e);
  }
  async _enterYamlMode(e) {
    if (!this._config || this._isScopeYaml(e))
      return;
    if (this._hasBlockingDescendantYamlErrors(e)) {
      this._message = {
        kind: "error",
        text: this._t("editor.messages.fix_descendant_yaml_errors")
      };
      return;
    }
    const t = Ze(e);
    try {
      if (await Qe(), !this._config || this._isScopeYaml(e))
        return;
      const i = this._omitScopeIds(this._scopeModes, t);
      i[e] = "yaml";
      const o = this._omitScopeIds(
        this._scopeYamlValues,
        t
      );
      o[e] = Z(e).adapter.read(this._config);
      const r = this._omitScopeIds(
        this._scopeYamlErrors,
        t
      );
      delete r[e], this._scopeModes = i, this._scopeYamlValues = o, this._scopeYamlErrors = r, this._message = null;
    } catch (i) {
      this._message = {
        kind: "error",
        text: this._formatError(
          i,
          this._t("editor.messages.load_ha_yaml_editor_failed")
        )
      };
    }
  }
  _exitYamlMode(e) {
    if (!this._isScopeYaml(e) || this._scopeYamlErrors[e])
      return;
    const t = { ...this._scopeModes };
    delete t[e];
    const i = { ...this._scopeYamlValues };
    delete i[e];
    const o = { ...this._scopeYamlErrors };
    delete o[e], this._scopeModes = t, this._scopeYamlValues = i, this._scopeYamlErrors = o;
  }
  _handleYamlValueChanged(e, t) {
    if (t.stopPropagation(), !t.detail.isValid) {
      this._scopeYamlErrors = {
        ...this._scopeYamlErrors,
        [e]: t.detail.errorMsg ?? this._t("editor.yaml.errors.parse_failed")
      };
      return;
    }
    const i = Xe(t.detail.value);
    if (!i.ok) {
      this._scopeYamlErrors = {
        ...this._scopeYamlErrors,
        [e]: this._t("editor.yaml.errors.non_json_value")
      };
      return;
    }
    const o = Z(e).adapter, r = o.validate(i.value);
    if (r) {
      this._scopeYamlErrors = {
        ...this._scopeYamlErrors,
        [e]: this._formatScopeYamlValidationError(r)
      };
      return;
    }
    try {
      const n = w(i.value);
      this._config = o.apply(this._config ?? {}, n), this._dirty = !0, this._validation = null, this._message = null, this._scopeYamlValues = {
        ...this._scopeYamlValues,
        [e]: n
      };
      const l = { ...this._scopeYamlErrors };
      delete l[e], this._scopeYamlErrors = l;
    } catch (n) {
      this._scopeYamlErrors = {
        ...this._scopeYamlErrors,
        [e]: this._formatError(n, this._t("editor.yaml.errors.apply_failed"))
      };
    }
  }
  _hasBlockingYamlErrors() {
    return Object.values(this._scopeYamlErrors).some(
      (e) => typeof e == "string" && e.length > 0
    ) || Object.values(this._applianceYamlErrors).some(
      (e) => typeof e == "string" && e.length > 0
    );
  }
  _hasBlockingDescendantYamlErrors(e) {
    return Ze(e).some(
      (t) => {
        const i = this._scopeYamlErrors[t];
        return typeof i == "string" && i.length > 0;
      }
    );
  }
  _resetScopeYamlState() {
    this._scopeModes = {}, this._scopeYamlValues = {}, this._scopeYamlErrors = {}, this._applianceModes = {}, this._applianceYamlValues = {}, this._applianceYamlErrors = {};
  }
  _omitScopeIds(e, t) {
    const i = { ...e };
    for (const o of t)
      delete i[o];
    return i;
  }
  _getScopeMode(e) {
    return this._scopeModes[e] ?? "visual";
  }
  _isScopeYaml(e) {
    return this._getScopeMode(e) === "yaml";
  }
  _scopeDomId(e) {
    return e.replaceAll(":", "-").replaceAll(".", "-");
  }
  _handleAddDeviceLabel(e) {
    const t = M(this._getValue(["device_label_text", e])).map(
      ([o]) => o
    ), i = ei(t);
    this._applyMutation((o) => {
      g(o, ["device_label_text", e, i], "");
    });
  }
  _handleSurplusApplianceIdChange(e, t) {
    const i = t.trim(), o = ["automation", "optimizers", e, "params"];
    this._applyMutation((r) => {
      g(r, [...o, "appliance_id"], i);
      const n = ue(
        r,
        this._liveApplianceMetadata,
        i
      ), l = he(
        n,
        this._stringValue(f(r, [...o, "climate_mode"]))
      );
      if (!l.visible || l.unavailable) {
        L(r, [...o, "climate_mode"]);
        return;
      }
      g(r, [...o, "climate_mode"], l.value);
    });
  }
  _handleAddVehicle(e) {
    const t = ["appliances", e, "vehicles"], i = ($(this._getValue(t)) ?? []).map((o) => {
      var r;
      return this._stringValue((r = y(o)) == null ? void 0 : r.id);
    }).filter((o) => o.length > 0);
    this._applyMutation((o) => {
      S(
        o,
        t,
        ct(
          i,
          this._tFormat("editor.dynamic.vehicle", { index: i.length + 1 })
        )
      );
    });
  }
  _handleAddUseMode(e) {
    const t = [
      "appliances",
      e,
      "controls",
      "use_mode",
      "values"
    ], i = di(M(this._getValue(t)).map(([o]) => o));
    this._applyMutation((o) => {
      g(o, [...t, i], ai());
    });
  }
  _handleAddEcoGear(e) {
    const t = [
      "appliances",
      e,
      "controls",
      "eco_gear",
      "values"
    ], i = ci(M(this._getValue(t)).map(([o]) => o));
    this._applyMutation((o) => {
      g(o, [...t, i], ri());
    });
  }
  _handleProjectedApplianceProjectionStrategyChange(e, t) {
    ["fixed", "history_average"].includes(t) && this._applyMutation((i) => {
      const o = ["appliances", e, "projection"];
      if (g(i, [...o, "strategy"], t), t !== "history_average")
        return;
      const r = y(
        f(i, [...o, "history_average"])
      ), n = r == null ? void 0 : r.lookback_days;
      g(i, [...o, "history_average"], {
        energy_entity_id: this._stringValue(r == null ? void 0 : r.energy_entity_id),
        lookback_days: typeof n == "number" && Number.isFinite(n) ? n : 30
      });
    });
  }
  _handleRenameObjectKey(e, t, i) {
    const o = i.trim();
    if (!o || o === t || !this._config)
      return;
    const r = w(this._config), n = Qt(r, e, t, o);
    if (!n.ok) {
      this._message = { kind: "error", text: this._formatRenameObjectKeyError(n) };
      return;
    }
    this._config = r, this._dirty = !0, this._validation = null, this._message = null;
  }
  _moveListItem(e, t, i) {
    this._applyMutation((o) => {
      Jt(o, e, t, i);
    });
  }
  _removeListItem(e, t) {
    this._applyMutation((i) => {
      Gt(i, e, t);
    });
  }
  _removePath(e) {
    this._applyMutation((t) => {
      L(t, e);
    });
  }
  _setOptionalString(e, t) {
    const i = t.trim();
    this._applyMutation((o) => {
      if (!i) {
        L(o, e);
        return;
      }
      g(o, e, i);
    });
  }
  _setRequiredString(e, t) {
    this._applyMutation((i) => {
      g(i, e, t.trim());
    });
  }
  _setOptionalNumber(e, t) {
    const i = t.trim();
    this._applyMutation((o) => {
      if (!i) {
        L(o, e);
        return;
      }
      const r = Number(i);
      g(o, e, Number.isFinite(r) ? r : i);
    });
  }
  _setRequiredNumber(e, t) {
    const i = t.trim();
    this._applyMutation((o) => {
      if (!i) {
        g(o, e, null);
        return;
      }
      const r = Number(i);
      g(o, e, Number.isFinite(r) ? r : i);
    });
  }
  _getAutomationEnabled() {
    const e = y(this._getValue(["automation"]));
    return e ? this._booleanValue(e.enabled, !0) : !1;
  }
  _setAutomationEnabled(e) {
    !e && this._getValue(["automation"]) === void 0 || this._applyMutation((t) => {
      const i = f(t, ["automation"]), o = y(i);
      if (o) {
        g(t, ["automation", "enabled"], e), Array.isArray(o.optimizers) || g(t, ["automation", "optimizers"], []);
        return;
      }
      g(t, ["automation"], {
        enabled: e,
        optimizers: []
      });
    });
  }
  _setBoolean(e, t) {
    this._applyMutation((i) => {
      g(i, e, t);
    });
  }
  _normalizeSurplusApplianceOptimizerParams(e) {
    const t = $(f(e, ["automation", "optimizers"])) ?? [];
    let i = !1;
    return t.forEach((o, r) => {
      var m;
      const n = y(o);
      if (!n || this._stringValue(n.kind) !== et)
        return;
      const l = ["automation", "optimizers", r, "params"], d = this._stringValue(f(e, [...l, "appliance_id"])), c = this._stringValue(
        f(e, [...l, "climate_mode"])
      ), h = ue(
        e,
        this._liveApplianceMetadata,
        d
      ), _ = he(
        h,
        c
      );
      if (((m = h.selectedOption) == null ? void 0 : m.kind) === "generic" && c.length > 0) {
        L(e, [...l, "climate_mode"]), i = !0;
        return;
      }
      _.visible && !_.unavailable && c.length === 0 && _.value.length > 0 && (g(e, [...l, "climate_mode"], _.value), i = !0);
    }), i;
  }
  _applyMutation(e) {
    const t = w(this._config ?? {});
    e(t), this._config = t, this._dirty = !0, this._validation = null, this._message = null;
  }
  _getValue(e) {
    if (this._config)
      return f(this._config, e);
  }
  _stringValue(e) {
    return typeof e == "string" ? e : typeof e == "number" ? String(e) : "";
  }
  _renderSurplusApplianceActionField(e) {
    return s`
      <div class="field">
        <div class="field-label-row">
          <label>${this._t("editor.fields.optimizer_action")}</label>
          ${this._renderHelpIcon(
      "editor.fields.optimizer_action",
      "editor.help.surplus_appliance_action"
    )}
        </div>
        <input .value=${e} disabled />
        <div class="helper">${this._t("editor.helpers.surplus_appliance_action")}</div>
      </div>
    `;
  }
  _renderSurplusClimateModeField(e, t) {
    const i = t.value.length > 0 ? t.value : "__live_modes_unavailable__";
    return s`
      <div class="field">
        <div class="field-label-row">
          <label>${this._t("editor.fields.climate_mode")}</label>
          ${this._renderHelpIcon(
      "editor.fields.climate_mode",
      "editor.help.surplus_appliance_climate_mode"
    )}
        </div>
        <select
          ?disabled=${t.disabled}
          @change=${(o) => this._setRequiredString(
      [...e, "climate_mode"],
      o.currentTarget.value
    )}
        >
          ${t.options.length > 0 ? t.options.map(
      (o) => s`
                  <option
                    value=${o.value}
                    ?selected=${o.value === i}
                  >
                    ${this._formatSurplusClimateModeLabel(o.value, o.isUnknown)}
                  </option>
                `
    ) : s`
                <option value="__live_modes_unavailable__" ?selected=${!0}>
                  ${this._t("editor.values.live_modes_unavailable")}
                </option>
              `}
        </select>
        <div class="helper">
          ${this._renderSurplusClimateModeHelper(t)}
        </div>
      </div>
    `;
  }
  _renderSurplusApplianceIdHelper(e) {
    return e.selectedMissingFromDraft && e.selectedId.length > 0 ? this._t("editor.helpers.surplus_appliance_id_missing_from_draft") : e.options.some((t) => t.selectionDisabled) ? this._t("editor.helpers.surplus_appliance_id_pending_reload") : this._t("editor.helpers.surplus_appliance_id");
  }
  _getSurplusApplianceOptimizerTitle(e, t) {
    return e.selectedOption ? e.selectedOption.name : e.selectedMissingFromDraft && e.selectedId.length > 0 ? this._tFormat("editor.dynamic.stale_appliance", {
      id: e.selectedId
    }) : t;
  }
  _renderSurplusClimateModeHelper(e) {
    return e.unavailable ? this._t("editor.helpers.surplus_appliance_climate_mode_unavailable") : e.options.some((t) => t.isUnknown) ? this._t("editor.helpers.surplus_appliance_climate_mode_unknown") : e.disabled ? this._t("editor.helpers.surplus_appliance_climate_mode_single") : this._t("editor.helpers.surplus_appliance_climate_mode");
  }
  _formatSurplusApplianceOptionLabel(e) {
    const t = e.name === e.id ? e.id : this._tFormat("editor.dynamic.appliance_option", {
      name: e.name,
      id: e.id
    });
    return e.selectionDisabled ? this._tFormat("editor.dynamic.appliance_option_pending_reload", {
      label: t
    }) : t;
  }
  _formatSurplusClimateModeLabel(e, t) {
    return t ? this._tFormat("editor.dynamic.stale_climate_mode", { mode: e }) : this._t(`editor.values.${e}`);
  }
  async _loadLiveApplianceMetadata() {
    if (!this.hass)
      return null;
    try {
      const e = await this.hass.callWS({
        type: "helman/get_appliances"
      });
      return Array.isArray(e == null ? void 0 : e.appliances) ? e : { appliances: [] };
    } catch {
      return null;
    }
  }
  _booleanValue(e, t) {
    return typeof e == "boolean" ? e : t;
  }
  _t(e) {
    return (this._localize ?? this._fallbackLocalize)(e);
  }
  _tFormat(e, t) {
    let i = this._t(e);
    for (const [o, r] of Object.entries(t))
      i = i.replaceAll(`{${o}}`, String(r));
    return i;
  }
  _formatScopeYamlValidationError(e) {
    switch (e.code) {
      case "expected_object":
        return this._t("editor.yaml.errors.expected_object");
      case "expected_array":
        return this._t("editor.yaml.errors.expected_array");
      case "unexpected_key":
        return this._tFormat("editor.yaml.errors.unexpected_key", {
          key: e.key ?? ""
        });
    }
  }
  _formatRenameObjectKeyError(e) {
    switch (e.reason) {
      case "target_not_available":
        return this._t("editor.rename.target_not_available");
      case "empty_key":
        return this._t("editor.rename.key_empty");
      case "duplicate_key":
        return this._tFormat("editor.rename.key_exists", {
          key: e.key ?? ""
        });
      case "missing_key":
        return this._tFormat("editor.rename.key_missing", {
          key: e.key ?? ""
        });
    }
  }
  _formatError(e, t) {
    if (typeof e == "object" && e !== null && "message" in e) {
      const i = e.message;
      if (typeof i == "string" && i)
        return i;
    }
    return t;
  }
};
se.properties = {
  hass: { attribute: !1 },
  narrow: { type: Boolean },
  route: { attribute: !1 },
  panel: { attribute: !1 },
  _activeTab: { state: !0 },
  _config: { state: !0 },
  _dirty: { state: !0 },
  _loading: { state: !0 },
  _saving: { state: !0 },
  _validating: { state: !0 },
  _validation: { state: !0 },
  _message: { state: !0 },
  _hasLoadedOnce: { state: !0 },
  _scopeModes: { state: !0 },
  _scopeYamlValues: { state: !0 },
  _scopeYamlErrors: { state: !0 },
  _applianceModes: { state: !0 },
  _applianceYamlValues: { state: !0 },
  _applianceYamlErrors: { state: !0 },
  _liveApplianceMetadata: { state: !0 },
  _helpDialog: { state: !0 }
}, se.styles = at`
    :host {
      display: block;
      min-height: 100%;
      background: var(--primary-background-color);
      color: var(--primary-text-color);
    }

    * {
      box-sizing: border-box;
    }

    .page {
      max-width: 1240px;
      margin: 0 auto;
      padding: 24px 20px 48px;
    }

    .header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 24px;
    }

    .title-block h1 {
      margin: 0 0 8px;
      font-size: 1.9rem;
      line-height: 1.2;
    }

    .title-block p {
      margin: 0;
      color: var(--secondary-text-color);
      max-width: 780px;
      line-height: 1.5;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      justify-content: flex-end;
    }

    .mode-toggle {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 2px;
      border: 1px solid var(--divider-color);
      border-radius: 999px;
      background: var(--card-background-color);
    }

    .mode-toggle button {
      border: none;
      background: transparent;
      color: var(--secondary-text-color);
      padding: 4px 10px;
      border-radius: 999px;
      cursor: pointer;
      font: inherit;
      font-size: 0.76rem;
      font-weight: 600;
    }

    .mode-toggle button:hover {
      background: rgba(127, 127, 127, 0.08);
    }

    .mode-toggle button.active {
      background: rgba(3, 169, 244, 0.12);
      color: var(--primary-color);
    }

    .mode-toggle button.active:hover {
      background: rgba(3, 169, 244, 0.16);
    }

    .actions button,
    .inline-actions button,
    .list-actions button,
    .add-button {
      border: 1px solid var(--divider-color);
      background: var(--card-background-color);
      color: var(--primary-text-color);
      padding: 10px 14px;
      border-radius: 999px;
      cursor: pointer;
      font: inherit;
      transition: background 0.2s ease, border-color 0.2s ease;
    }

    .actions button:hover,
    .inline-actions button:hover,
    .list-actions button:hover,
    .add-button:hover {
      background: rgba(127, 127, 127, 0.08);
    }

    .actions button.primary,
    .add-button.primary {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: var(--text-primary-color, white);
    }

    .actions button.primary:hover,
    .add-button.primary:hover {
      filter: brightness(1.03);
    }

    .actions button.danger,
    .inline-actions button.danger,
    .list-actions button.danger {
      border-color: var(--error-color);
      color: var(--error-color);
    }

    .actions button:disabled,
    .inline-actions button:disabled,
    .list-actions button:disabled,
    .add-button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .status-row {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      margin-bottom: 16px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 6px 12px;
      font-size: 0.88rem;
      border: 1px solid var(--divider-color);
      background: var(--card-background-color);
    }

    .badge.info {
      color: var(--secondary-text-color);
    }

    .message {
      border: 1px solid var(--divider-color);
      border-radius: 16px;
      padding: 14px 16px;
      margin-bottom: 16px;
      background: var(--card-background-color);
    }

    .message.success {
      border-color: #2e7d32;
      background: rgba(46, 125, 50, 0.08);
    }

    .message.error {
      border-color: var(--error-color);
      background: rgba(244, 67, 54, 0.08);
    }

    .message.info {
      border-color: var(--primary-color);
      background: rgba(3, 169, 244, 0.08);
    }

    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 20px;
    }

    .tabs button {
      border: 1px solid var(--divider-color);
      background: var(--card-background-color);
      color: var(--primary-text-color);
      border-radius: 999px;
      padding: 10px 16px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font: inherit;
    }

    .tabs button.active {
      border-color: var(--primary-color);
      color: var(--primary-color);
      background: rgba(3, 169, 244, 0.08);
    }

    .tab-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 22px;
      height: 22px;
      border-radius: 999px;
      padding: 0 6px;
      font-size: 0.78rem;
      background: rgba(127, 127, 127, 0.18);
      color: inherit;
    }

    .tab-count.errors {
      background: rgba(244, 67, 54, 0.12);
      color: var(--error-color);
    }

    .tab-count.warnings {
      background: rgba(255, 152, 0, 0.12);
      color: #ef6c00;
    }

    .issue-board {
      display: grid;
      gap: 14px;
      margin-bottom: 20px;
    }

    .issue-group {
      border: 1px solid var(--divider-color);
      border-radius: 16px;
      padding: 16px;
      background: var(--card-background-color);
    }

    .issue-group h3 {
      margin: 0 0 10px;
      font-size: 1rem;
    }

    .issue-group ul {
      margin: 0;
      padding-left: 18px;
      display: grid;
      gap: 8px;
    }

    .issue-path {
      font-family: var(--code-font-family, monospace);
      font-size: 0.9rem;
    }

    .tab-body {
      display: grid;
      gap: 16px;
    }

    .tab-scope {
      display: grid;
      gap: 16px;
    }

    .scope-toolbar {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 12px;
    }

    details.section-card,
    .list-card,
    .nested-card {
      border: 1px solid var(--divider-color);
      border-radius: 18px;
      background: var(--card-background-color);
    }

    details.section-card {
      padding: 0 18px 18px;
    }

    details.section-card > summary {
      list-style: none;
      cursor: pointer;
      padding: 14px 0;
      font-size: 1.06rem;
      font-weight: 700;
      border-bottom: 1px solid transparent;
      transition: border-color 0.15s ease;
      user-select: none;
    }

    details.section-card[open] > summary {
      border-bottom-color: var(--divider-color);
      margin-bottom: 14px;
    }

    .section-summary-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .section-summary-left {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .section-icon {
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      fill: var(--primary-color);
      opacity: 0.85;
    }

    .section-summary-label {
      min-width: 0;
    }

    .section-chevron {
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      fill: var(--secondary-text-color);
      transition: transform 0.2s ease;
      transform: rotate(0deg);
    }

    details.section-card[open] > summary .section-chevron {
      transform: rotate(90deg);
    }

    details.section-card > summary::-webkit-details-marker {
      display: none;
    }

    .section-content {
      display: grid;
      gap: 18px;
    }

    /* Collapsible appliance cards */
    details.list-card {
      padding: 0;
    }

    details.list-card > summary {
      list-style: none;
      cursor: pointer;
      padding: 14px 16px;
      border-radius: 18px;
      transition: border-radius 0.15s ease;
      user-select: none;
    }

    details.list-card[open] > summary {
      border-radius: 18px 18px 0 0;
      border-bottom: 1px solid var(--divider-color);
    }

    details.list-card > summary::-webkit-details-marker {
      display: none;
    }

    details.optimizer-card > summary {
      border: 1px solid transparent;
    }

    details.optimizer-card.optimizer-card--enabled > summary {
      background: rgba(46, 125, 50, 0.1);
      border-color: rgba(46, 125, 50, 0.28);
    }

    details.optimizer-card.optimizer-card--disabled > summary {
      background: rgba(127, 127, 127, 0.08);
      border-color: rgba(127, 127, 127, 0.22);
    }

    .appliance-summary-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .appliance-summary-left {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .appliance-chevron {
      flex-shrink: 0;
      width: 16px;
      height: 16px;
      fill: var(--secondary-text-color);
      transition: transform 0.2s ease;
      transform: rotate(0deg);
      margin-left: 4px;
    }

    details.list-card[open] > summary .appliance-chevron {
      transform: rotate(90deg);
    }

    .appliance-body {
      padding: 16px;
      display: grid;
      gap: 14px;
    }

    .tab-icon {
      flex-shrink: 0;
      width: 16px;
      height: 16px;
      fill: currentColor;
    }

    .field-grid {
      display: grid;
      gap: 16px;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    }

    .field-grid > * {
      min-width: 0;
    }

    .field-grid--roomy {
      grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr));
    }

    .field {
      display: grid;
      gap: 8px;
      align-content: start;
      min-width: 0;
    }

    .toggle-field {
      display: block;
    }

    .toggle-field ha-formfield {
      display: block;
      width: 100%;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid var(--divider-color);
      background: var(--secondary-background-color);
      color: var(--primary-text-color);
    }

    .field label {
      font-weight: 600;
      font-size: 0.93rem;
    }

    .field input,
    .field select,
    .field textarea {
      width: 100%;
      border-radius: 12px;
      border: 1px solid var(--divider-color);
      background: var(--secondary-background-color);
      color: var(--primary-text-color);
      padding: 12px 14px;
      font: inherit;
    }

    .number-input-wrap {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: stretch;
    }

    .number-input-wrap input {
      border-top-right-radius: 0;
      border-bottom-right-radius: 0;
    }

    .number-input-suffix {
      display: inline-flex;
      align-items: center;
      padding: 0 12px;
      border: 1px solid var(--divider-color);
      border-left: 0;
      border-top-right-radius: 12px;
      border-bottom-right-radius: 12px;
      background: var(--secondary-background-color);
      color: var(--secondary-text-color);
      font-size: 0.9rem;
      white-space: nowrap;
    }

    .field textarea {
      min-height: 120px;
      resize: vertical;
    }

    .yaml-surface {
      display: grid;
      gap: 12px;
    }

    .yaml-field ha-yaml-editor {
      display: block;
      --code-mirror-height: clamp(320px, 58vh, 720px);
      --code-mirror-max-height: clamp(320px, 58vh, 720px);
    }

    .yaml-field--document ha-yaml-editor {
      --code-mirror-height: clamp(420px, 72vh, 980px);
      --code-mirror-max-height: clamp(420px, 72vh, 980px);
    }

    .yaml-error {
      margin: 0;
    }

    .field ha-entity-picker,
    .field ha-selector {
      display: block;
      width: 100%;
      min-width: 0;
      max-width: 100%;
    }

    .helper {
      color: var(--secondary-text-color);
      font-size: 0.86rem;
      line-height: 1.4;
    }

    .list-stack {
      display: grid;
      gap: 14px;
    }

    .list-card,
    .nested-card {
      padding: 16px;
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      margin-bottom: 14px;
    }

    .card-title {
      display: grid;
      gap: 4px;
    }

    .card-title strong {
      font-size: 1rem;
    }

    .card-subtitle {
      color: var(--secondary-text-color);
      font-size: 0.88rem;
    }

    .inline-actions,
    .list-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    .summary-toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid var(--divider-color);
      background: var(--card-background-color);
      color: var(--primary-text-color);
      font-size: 0.82rem;
      font-weight: 600;
      white-space: nowrap;
    }

    .summary-toggle ha-switch {
      --mdc-theme-secondary: var(--primary-color);
    }

    .inline-note {
      color: var(--secondary-text-color);
      font-size: 0.9rem;
    }

    pre.raw-preview {
      margin: 0;
      padding: 14px;
      border-radius: 14px;
      background: var(--secondary-background-color);
      overflow: auto;
      white-space: pre-wrap;
      font-size: 0.84rem;
      line-height: 1.45;
    }

    .section-footer {
      display: flex;
      justify-content: flex-start;
      margin-top: 4px;
    }

    @media (max-width: 900px) {
      .header {
        flex-direction: column;
      }

      .actions,
      .scope-toolbar {
        justify-content: flex-start;
      }
    }

    .field-label-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .field-label-row label {
      flex: 1;
      min-width: 0;
    }

    .help-btn {
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 1px solid var(--secondary-text-color);
      background: transparent;
      color: var(--secondary-text-color);
      cursor: pointer;
      font: inherit;
      font-size: 0.72rem;
      font-weight: 700;
      line-height: 1;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .help-btn:hover {
      border-color: var(--primary-color);
      color: var(--primary-color);
      background: rgba(3, 169, 244, 0.08);
    }

    .help-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .help-dialog {
      background: var(--card-background-color);
      border-radius: 18px;
      padding: 22px 24px;
      max-width: 480px;
      width: 100%;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.24);
    }

    .help-dialog-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 14px;
    }

    .help-dialog-header strong {
      font-size: 1.05rem;
      line-height: 1.3;
    }

    .help-dialog-close {
      flex-shrink: 0;
      border: 1px solid var(--divider-color);
      background: var(--card-background-color);
      color: var(--primary-text-color);
      width: 28px;
      height: 28px;
      border-radius: 50%;
      cursor: pointer;
      font: inherit;
      font-size: 0.9rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }

    .help-dialog-close:hover {
      background: rgba(127, 127, 127, 0.08);
    }

    .help-dialog-body {
      color: var(--secondary-text-color);
      line-height: 1.55;
      margin: 0;
      font-size: 0.93rem;
    }
  `;
let be = se;
const tt = "helman-config-editor-panel";
customElements.get(tt) || customElements.define(tt, be);
