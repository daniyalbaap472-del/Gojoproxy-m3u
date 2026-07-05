const axios = require('axios');
const crypto = require('crypto');

const STALKER_UA = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 4 rev: 2116 Mobile Safari/533.3';
const STALKER_XUA = 'Model: MAG254; Link: Ethernet';

function buildCookie(sn, mac) {
  return `PHPSESSID=null; sn=${sn}; mac=${mac}; stb_lang=en; timezone=Europe/London`;
}

function computeSignature(mac, sn, deviceId1, deviceId2) {
  return crypto.createHash('sha256')
    .update(mac + sn + deviceId1 + deviceId2)
    .digest('hex')
    .toUpperCase();
}

module.exports = async (req, res) => {
  const {
    portal = 'http://tivi.stream4k.cc/stalker_portal',
    mac = '00:1A:79:00:01:CF',
    sn = 'C0F5AA5AC0780',
    signature: providedSig = '3A5C345C3E98FE6C9FB01D7D9C8E31EFBD0B5CB46F4FCEBC94FF0B81AE3DCF10'
  } = req.query;

  // Normalise portal URL
  const base = portal.replace(/\/+$/, '');
  const loadUrl = base.includes('/load.php') ? base : `${base}/server/load.php`;

  // Derive device IDs
  const deviceId1 = crypto.createHash('sha256').update(sn).digest('hex').toUpperCase();
  const deviceId2 = crypto.createHash('sha256').update(mac).digest('hex').toUpperCase();
  const signature = providedSig || computeSignature(mac, sn, deviceId1, deviceId2);

  try {
    // Step 1: Handshake
    const { data: handshakeData } = await axios.get(
      `${loadUrl}?type=stb&action=handshake&prehash=0&token=&JsHttpRequest=1-xml`,
      {
        headers: {
          'User-Agent': STALKER_UA,
          'X-User-Agent': STALKER_XUA,
          'Cookie': buildCookie(sn, mac)
        },
        timeout: 10000
      }
    );
    const token = handshakeData?.js?.Token || handshakeData?.js?.token || '';
    if (!token) throw new Error('Handshake failed – no token');

    // Step 2: Get profile (authenticate)
    const authHeaders = {
      'User-Agent': STALKER_UA,
      'X-User-Agent': STALKER_XUA,
      'Authorization': `Bearer ${token}`,
      'Cookie': buildCookie(sn, mac)
    };
    const profileUrl = `${loadUrl}?type=stb&action=get_profile&sn=${sn}&mac=${mac}&device_id=${deviceId1}&device_id2=${deviceId2}&signature=${signature}&auth_second_step=1&hw_version=1.7-BD-00&not_valid_token=0&JsHttpRequest=1-xml`;
    await axios.get(profileUrl, { headers: authHeaders, timeout: 10000 });

    // Step 3: Fetch all channels
    const { data: channelsData } = await axios.get(
      `${loadUrl}?type=itv&action=get_all_channels&force_ch_link_check=&JsHttpRequest=1-xml`,
      { headers: authHeaders, timeout: 15000 }
    );

    const channels = channelsData?.js?.data || [];
    if (!channels.length) throw new Error('No channels returned');

    // Step 4: Generate stream links and build M3U
    let m3u = '#EXTM3U\n';
    for (const ch of channels) {
      const linkUrl = `${loadUrl}?action=create_link&type=itv&cmd=${encodeURIComponent(ch.cmd)}&JsHttpRequest=1-xml`;
      try {
        const { data: linkData } = await axios.get(linkUrl, { headers: authHeaders, timeout: 10000 });
        const streamUrl = (linkData?.js?.cmd || '').split(' ').pop();
        if (streamUrl && streamUrl.startsWith('http')) {
          m3u += `#EXTINF:0 tvg-id="${ch.name}" tvg-logo="${ch.logo || ''}" group-title="${ch.tv_genre_id || 'General'}",${ch.name}\n${streamUrl}\n`;
        }
      } catch { /* skip dead links */ }
    }

    // Return M3U
    res.setHeader('Content-Type', 'audio/mpegurl');
    res.setHeader('Content-Disposition', 'attachment; filename="playlist.m3u"');
    res.status(200).send(m3u);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
