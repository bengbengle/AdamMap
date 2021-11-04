import { createAsyncResourceBundle, createSelector } from 'redux-bundler'
import { getConfiguredCache } from 'money-clip'
import geoip from 'ipfs-geoip'
import PQueue from 'p-queue'
import HLRU from 'hashlru'
import Multiaddr from 'multiaddr'
import ms from 'milliseconds'
import ip from 'ip'
import memoize from 'p-memoize'
import { dependencies } from '../../package.json'

// After this time interval, we re-check the locations for each peer
// once again through PeerLocationResolver.
// 在此时间间隔之后，我们再次通过 PeerLocationResolver 重新检查每个对等方的位置再次
const UPDATE_EVERY = ms.seconds(1)

// We reuse cached geoip lookups as long geoipVersion is the same.
const geoipVersion = dependencies['ipfs-geoip']

// Depends on ipfsBundle, peersBundle
function createPeersLocations (opts) {
  opts = opts || {}
  // Max number of locations to retrieve concurrently.
  // HTTP API are throttled to max 4-6 at a time by the browser itself.
  // 同时检索的最大位置数。 HTTP API 一次被浏览器限制为最多 4-6 个
  opts.concurrency = opts.concurrency || 4
  // Cache options
  opts.cache = opts.cache || {}

  const peerLocResolver = new PeerLocationResolver(opts)

  const bundle = createAsyncResourceBundle({
    name: 'peerLocations',
    actionBaseType: 'PEER_LOCATIONS',
    getPromise: async ({ store, getIpfs }) => {
      const peers = store.selectPeers()
      return peerLocResolver.findLocations(peers, getIpfs)
    },
    staleAfter: UPDATE_EVERY,
    retryAfter: UPDATE_EVERY,
    persist: false,
    checkIfOnline: false
  })

  bundle.reactPeerLocationsFetch = createSelector(
    'selectRouteInfo',
    'selectPeerLocationsShouldUpdate',
    'selectIpfsConnected',
    (routeInfo, shouldUpdate, ipfsConnected) => {
      // if (routeInfo.url === '/peers' && shouldUpdate && ipfsConnected) {
      if (shouldUpdate && ipfsConnected) {
        return { actionCreator: 'doFetchPeerLocations' }
      }
    }
  )

  bundle.selectPeerLocationsForSwarm = createSelector(
    'selectPeers',
    'selectPeerLocations',
    'selectBootstrapPeers',
    'selectIdentity', // ipfs.id info for local node, used for detecting local peers
    (peers, locations = {}, bootstrapPeers, identity) => peers && peers.map(peer => {
      const peerId = peer.peer
      const locationObj = locations ? locations[peerId] : null
      const location = toLocationString(locationObj)
      // const flagCode = locationObj && locationObj.country_code
      const coordinates = locationObj && [
        locationObj.longitude,
        locationObj.latitude
      ]
      const connection = parseConnection(peer.addr)
      const address = peer.addr.toString()
      const latency = parseLatency(peer.latency)
      const direction = peer.direction
      const { isPrivate, isNearby } = isPrivateAndNearby(peer.addr, identity)

      return {
        power: peer.power,
        poolname: peer.poolname,
        peerId,
        location,
        flagCode: 'zh',
        coordinates,
        connection,
        address,
        protocols: '',
        direction,
        latency,
        isPrivate,
        isNearby
      }
    })
  )

  const COORDINATES_RADIUS = 4

  bundle.selectPeersCoordinates = createSelector(
    'selectPeerLocationsForSwarm',
    peers => {
      if (!peers) return []

      return peers.reduce((previous, { peerId, coordinates }) => {
        if (!coordinates) return previous

        let hasFoundACloseCoordinate = false

        const previousCoordinates = previous.map(prev => {
          if (!prev || hasFoundACloseCoordinate) return prev

          const [x, y] = prev.coordinates
          const [currentX, currentY] = coordinates

          const isCloseInXAxis = x - COORDINATES_RADIUS <= currentX && x + COORDINATES_RADIUS >= currentX
          const isCloseInYAxis = y - COORDINATES_RADIUS <= currentY && y + COORDINATES_RADIUS >= currentY

          if (isCloseInXAxis && isCloseInYAxis) {
            prev.peerIds.push(peerId)
            hasFoundACloseCoordinate = true
          }

          return prev
        })

        if (hasFoundACloseCoordinate) {
          return previousCoordinates
        }

        return [...previousCoordinates, { peerIds: [peerId], coordinates }]
      }, [])
    }
  )

  return bundle
}

const isNonHomeIPv4 = t => t[0] === 4 && t[1] !== '127.0.0.1'

const toLocationString = loc => {
  if (!loc) return null
  const { country_name: country, city } = loc
  return city && country ? `${country}, ${city}` : country
}

const parseConnection = (multiaddr) => {
  if (multiaddr) {
    return multiaddr.protoNames().join(' • ')
  } else {
    return '-'
  }
  // return multiaddr && multiaddr.protoNames().join(' • ') || '-'
}

const parseLatency = (latency) => {
  if (latency === 'n/a') return

  let value = parseInt(latency)
  const unit = /(s|ms)/.exec(latency)[0]

  value = unit === 's' ? value * 1000 : value

  return value
}

const getPublicIP = memoize((identity) => {
  if (!identity) return

  for (const maddr of identity.addresses) {
    try {
      const addr = Multiaddr(maddr).nodeAddress()

      if ((ip.isV4Format(addr.address) || ip.isV6Format(addr.address)) && !ip.isPrivate(addr.address)) {
        // console.log('addr.address::', addr.address)
        return addr.address
      }
    } catch (_) {}
  }
})

const isPrivateAndNearby = (maddr, identity) => {
  const publicIP = getPublicIP(identity)
  let isPrivate = false
  let isNearby = false
  let addr

  try {
    addr = maddr.nodeAddress()
  } catch (_) {
    // Might explode if maddr does not have an IP or cannot be converted
    // to a node address. This might happen if it's a relay. We do not print
    // or handle the error, otherwise we would get perhaps thousands of logs.
    return { isPrivate, isNearby }
  }

  // At this point, addr.address and publicIP must be valid IP addresses. Hence,
  // none of the calls bellow for ip library should fail.
  isPrivate = ip.isPrivate(addr.address)

  if (publicIP) {
    if (ip.isV4Format(addr.address)) {
      isNearby = ip.cidrSubnet(`${publicIP}/24`).contains(addr.address)
    } else if (ip.isV6Format(addr.address)) {
      isNearby = ip.cidrSubnet(`${publicIP}/48`).contains(addr.address) &&
        !ip.cidrSubnet('fc00::/8').contains(addr.address)
      // peerIP6 ∉ fc00::/8 to fix case of cjdns where IPs are not spatial allocated.
    }
  }

  return { isPrivate, isNearby }
}

class PeerLocationResolver {
  constructor (opts) {
    this.geoipCache = getConfiguredCache({
      name: 'geoipCache',
      version: geoipVersion,
      maxAge: ms.weeks(1),
      ...opts.cache
    })
    window.global_cache = this.geoipCache
    console.log('geoipCache::', this.geoipCache, opts)
    this.failedAddrs = HLRU(500)

    this.queue = new PQueue({
      concurrency: opts.concurrency,
      autoStart: true
    })

    this.geoipLookupPromises = new Map()

    this.pass = 0
  }

  async findLocations (peers, getIpfs) {
    const res = {}
    // for (const p of ) {
    const peersopts = this.optimizedPeerSet(peers)
    for (const p of peersopts) {
      const peerId = p.peer
      const ipv4Tuple = p.addr.stringTuples().find(isNonHomeIPv4)
      if (!ipv4Tuple) {
        continue
      }
      const ipv4Addr = ipv4Tuple[1]
      if (this.failedAddrs.has(ipv4Addr)) {
        continue
      }
      // console.log('ipv4Addr::', ipv4Addr)
      // maybe we have it cached by ipv4 address already, check that.
      // 也许我们已经通过 ipv4 地址缓存了它，检查一下
      const location = await this.geoipCache.get(ipv4Addr)
      // console.log('location::', location)
      if (location) {
        res[peerId] = location
        continue
      }

      // no ip address cached. are we looking it up already?
      // ip 地址是否已经缓存过了
      if (this.geoipLookupPromises.has(ipv4Addr)) {
        continue
      }

      this.geoipLookupPromises.set(ipv4Addr, this.queue.add(async () => {
        try {
          const data = await geoip.lookup(getIpfs(), ipv4Addr)
          console.log('data::', data)
          await this.geoipCache.set(ipv4Addr, data)
        } catch (e) {
          // mark this one as failed so we don't retry again
          // 将此标记为失败，以便我们不再重试
          this.failedAddrs.set(ipv4Addr, true)
        } finally {
          this.geoipLookupPromises.delete(ipv4Addr)
        }
      }))
    }
    // console.log('res:::', res)
    return res
  }

  optimizedPeerSet (peers) {
    if (this.pass < 3) {
      // use a copy of peers sorted by latency so we can resolve closest ones first
      // (https://github.com/ipfs-shipyard/ipfs-webui/issues/1273)
      const ms = x => (parseLatency(x.latency) || 9999)
      const sortedPeersByLatency = peers.concat().sort((a, b) => ms(a) - ms(b))
      // take the closest subset, increase sample size each time
      // this ensures initial map updates are fast even with thousands of peers
      this.pass = this.pass + 1

      switch (this.pass - 1) {
        case 0:
          return sortedPeersByLatency.slice(0, 10)
        case 1:
          return sortedPeersByLatency.slice(0, 100)
        default:
          return sortedPeersByLatency.slice(0, 200)
      }
    }
    return peers
  }
}
export default createPeersLocations
