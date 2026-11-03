"""Published media install, upgrades and private-library boundaries."""
import hashlib,json,os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'native'))
from media import MediaLibrary


def bundle(root, version='1.0.0', content=b'music fixture'):
    data={'id':'amadeus-default-media','version':version,
          'music':[{'name':'bgm10','file':'music/bgm10.ogg'}],
          'backgrounds':[{'name':'room','file':'backgrounds/room.jpg'}],
          'models':[{'name':'fixture','file':'models/fixture/model.model3.json','tracking':'eyes'}],
          'defaults':{'track':'music/bgm10.ogg','background':'','selected_model':'','volume':12,'enabled':True,
                      'framing':'normal','ringtone':'ringtones/bgm13.mp3'},'files':[]}
    files={'music/bgm10.ogg':content,'backgrounds/room.jpg':b'background fixture',
           'models/fixture/model.model3.json':b'{"FileReferences":{"Moc":"model.moc3"}}',
           'models/fixture/model.moc3':b'geometry '+content,'ringtones/bgm13.mp3':b'ringtone '+content}
    for relative,raw in files.items():
        p=root/relative;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw)
        data['files'].append({'path':relative,'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
    (root/'catalog.json').write_text(json.dumps(data),encoding='utf8')
    return data


class MediaBundleTests(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();self.base=Path(self.folder.name)
        self.source=self.base/'release';self.data=bundle(self.source)
        self.library=MediaLibrary(self.base/'personal')
    def tearDown(self):self.folder.cleanup()

    def test_fresh_install_registers_every_category_and_quiet_defaults(self):
        self.assertTrue(self.library.install_bundle(self.source))
        fresh=MediaLibrary(self.library.root)
        self.assertEqual([len(fresh.state[k]) for k in ['music','backgrounds','models']],[1,1,1])
        self.assertEqual(fresh.state['track'],'music/bgm10.ogg')
        self.assertEqual(fresh.state['ringtone'],'ringtones/bgm13.mp3')
        self.assertEqual(fresh.state['volume'],12)
        self.assertEqual(fresh.state['background'],'')
        self.assertEqual(fresh.state['selected_model'],'')
        for row in self.data['files']:self.assertEqual(fresh.path(row['path']).read_bytes(),(self.source/row['path']).read_bytes())
        self.assertFalse(fresh.install_bundle(self.source))

    def test_hash_failure_validates_all_files_before_any_copy(self):
        (self.source/'ringtones/bgm13.mp3').write_bytes(b'broken')
        with self.assertRaises(ValueError):self.library.install_bundle(self.source)
        self.assertFalse(self.library.file.exists())
        self.assertFalse((self.library.root/'music').exists())

    def test_path_traversal_is_refused(self):
        self.data['files'][0]['path']='../escape.ogg'
        (self.source/'catalog.json').write_text(json.dumps(self.data),encoding='utf8')
        with self.assertRaises(ValueError):self.library.install_bundle(self.source)
        self.assertFalse(self.library.file.exists())

    def test_first_launch_imports_the_package_into_the_stable_profile(self):
        program=self.base/'program';bundle(program/'assets/media')
        env={'AMADEUS_DATA_DIR':'','AMADEUS_MEDIA_DIR':'','LOCALAPPDATA':str(self.base/'appdata')}
        with patch.dict(os.environ,env),patch.object(Path,'home',return_value=self.base/'profile'), \
                patch('media.__file__',str(program/'native/media.py')):
            first=MediaLibrary();self.assertEqual(first.bundle_error,'')
            self.assertEqual(len(first.state['models']),1)
            self.assertEqual(first.state['track'],'music/bgm10.ogg')
            first.state['volume']=7;first.save()
            os.environ['LOCALAPPDATA']=str(self.base/'other-appdata')
            second=MediaLibrary();self.assertEqual(second.root,first.root)
            self.assertEqual(second.state['volume'],7)
            self.assertEqual(len(second.state['music']),1)

    def test_upgrade_keeps_selections_and_backs_up_managed_files(self):
        self.library.install_bundle(self.source)
        self.library.state.update(track='',background='backgrounds/room.jpg',selected_model='models/fixture/model.model3.json',
                                  framing='closeup',enabled=False,volume=5,ringtone='custom/ring.mp3')
        self.library.save();choices={k:v for k,v in self.library.state.items() if k not in ('music','backgrounds','models')}
        old=(self.library.root/'models/fixture/model.moc3').read_bytes()
        bundle(self.source,'1.1.0',b'new music fixture')
        self.library.install_bundle(self.source)
        self.assertEqual(choices,{k:v for k,v in self.library.state.items() if k not in ('music','backgrounds','models')})
        self.assertEqual((self.library.root/'models/fixture/model.moc3').read_bytes(),b'geometry new music fixture')
        backups=list((self.library.root/'.bundle-backups').rglob('model.moc3'))
        self.assertEqual(len(backups),1);self.assertEqual(backups[0].read_bytes(),old)

    def test_custom_model_is_preserved_as_a_whole(self):
        self.library.install_bundle(self.source)
        geometry=self.library.root/'models/fixture/model.moc3';geometry.write_bytes(b'user edited mesh')
        entry=self.library.root/'models/fixture/model.model3.json';entry_before=entry.read_bytes()
        bundle(self.source,'1.1.0',b'new music fixture')
        self.library.install_bundle(self.source)
        self.assertEqual(geometry.read_bytes(),b'user edited mesh');self.assertEqual(entry.read_bytes(),entry_before)
        self.assertEqual((self.library.root/'music/bgm10.ogg').read_bytes(),b'new music fixture')

    def test_old_bundle_cannot_downgrade_newer_owned_assets(self):
        bundle(self.source,'1.1.0',b'new music fixture');self.library.install_bundle(self.source)
        bundle(self.source,'1.0.0',b'old music fixture')
        self.assertFalse(self.library.install_bundle(self.source))
        self.assertEqual((self.library.root/'music/bgm10.ogg').read_bytes(),b'new music fixture')

    def test_existing_empty_choices_and_private_files_are_not_replaced(self):
        self.library.save()
        private=self.library.root/'secrets.json';private.write_text('private fixture',encoding='utf8')
        self.library.install_bundle(self.source)
        self.assertEqual(self.library.state['track'],'')
        self.assertEqual(self.library.state['ringtone'],'')
        self.assertEqual(private.read_text(encoding='utf8'),'private fixture')
        self.assertEqual(len(self.library.state['models']),1)

    def test_stale_window_save_keeps_installed_bundle_rows(self):
        self.library.save();old_window=MediaLibrary(self.library.root)
        self.library.install_bundle(self.source)
        old_window.state['volume']=7;old_window.save()
        restored=MediaLibrary(self.library.root)
        self.assertEqual(restored.state['volume'],7)
        self.assertEqual([len(restored.state[k]) for k in ['music','backgrounds','models']],[1,1,1])


if __name__=='__main__':unittest.main()
