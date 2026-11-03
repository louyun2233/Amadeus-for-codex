import sys
import os
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from media import MediaLibrary, BackgroundMusic


class MediaTests(unittest.TestCase):
    def test_simultaneous_catalog_writers_preserve_every_import(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'library'
            seed = MediaLibrary(root)
            seed.save()
            libraries = [MediaLibrary(root) for _ in range(8)]
            barrier = Barrier(len(libraries))
            def write(index):
                library = libraries[index]
                library.state['music'].append({'name': str(index), 'file': 'music/' + str(index) + '.mp3'})
                barrier.wait(3)
                library.save()
            with ThreadPoolExecutor(max_workers=8) as pool:
                for future in [pool.submit(write, i) for i in range(8)]:
                    future.result(timeout=5)
            self.assertEqual({row['name'] for row in MediaLibrary(root).state['music']}, {str(i) for i in range(8)})

    def test_default_catalog_survives_different_appdata_launch_contexts(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            legacy = MediaLibrary(base / 'packaged/Amadeus/media')
            music = base / 'song.mp3'
            music.write_bytes(b'fixture music' * 500)
            key = legacy.import_file(music, 'music')
            model = legacy.root / 'models/test/model.model3.json'
            model.parent.mkdir(parents=True)
            model.write_text('{}', encoding='utf-8')
            (model.parent / 'texture.png').write_bytes(b'fixture texture')
            legacy.state['models'] = [{'name': 'fixture', 'file': 'models/test/model.model3.json'}]
            legacy.state.update(track=key, volume=17)
            legacy.save()
            env = {'AMADEUS_DATA_DIR': '', 'AMADEUS_MEDIA_DIR': '', 'LOCALAPPDATA': str(base / 'packaged')}
            with patch.dict(os.environ, env), patch.object(Path, 'home', return_value=base / 'profile'), \
                    patch.object(MediaLibrary, 'install_bundle', return_value=False):
                migrated = MediaLibrary()
                self.assertEqual(migrated.state['track'], key)
                self.assertEqual(migrated.state['volume'], 17)
                self.assertEqual(migrated.path(key).read_bytes(), music.read_bytes())
                self.assertEqual((migrated.path('models/test/model.model3.json').parent / 'texture.png').read_bytes(), b'fixture texture')
                os.environ['LOCALAPPDATA'] = str(base / 'desktop')
                restarted = MediaLibrary()
                self.assertEqual(restarted.root, migrated.root)
                self.assertEqual(restarted.state, migrated.state)
                self.assertEqual(len(restarted.state['models']), 1)

    def test_stale_window_saving_volume_keeps_newly_installed_catalog(self):
        with tempfile.TemporaryDirectory() as folder:
            older = MediaLibrary(Path(folder) / 'library')
            older.save()
            installer = MediaLibrary(older.root)
            installer.state['models'] = [{'name': 'new model', 'file': 'models/new/model.model3.json'}]
            installer.save()
            older.state['volume'] = 6
            older.save()
            reopened = MediaLibrary(older.root)
            self.assertEqual(reopened.state['volume'], 6)
            self.assertEqual(len(reopened.state['models']), 1)
            self.assertEqual(older.state['models'], reopened.state['models'])

    def test_two_windows_importing_music_do_not_erase_each_others_track(self):
        with tempfile.TemporaryDirectory() as folder:
            a = MediaLibrary(Path(folder) / 'library')
            a.save()
            b = MediaLibrary(a.root)
            a.state['music'].append({'name': 'a', 'file': 'music/a.mp3'})
            b.state['music'].append({'name': 'b', 'file': 'music/b.mp3'})
            a.save()
            b.save()
            self.assertEqual({row['name'] for row in MediaLibrary(a.root).state['music']}, {'a', 'b'})

    def test_corrupt_catalog_without_backup_cannot_be_overwritten_by_defaults(self):
        with tempfile.TemporaryDirectory() as folder:
            library = MediaLibrary(Path(folder) / 'library')
            library.file.write_text('{broken', encoding='utf-8')
            broken = MediaLibrary(library.root)
            with self.assertRaises(OSError):
                broken.save()
            self.assertEqual(library.file.read_text(encoding='utf-8'), '{broken')

    def test_corrupt_catalog_recovers_last_good_backup(self):
        with tempfile.TemporaryDirectory() as folder:
            library = MediaLibrary(Path(folder) / 'library')
            library.state['music'] = [{'name': 'keep', 'file': 'music/keep.mp3'}]
            library.save()
            library.state['volume'] = 9
            library.save()
            library.file.write_text('[]', encoding='utf-8')
            recovered = MediaLibrary(library.root)
            self.assertTrue(recovered.recovered)
            self.assertEqual(recovered.state['music'][0]['name'], 'keep')
            recovered.state['volume'] = 7
            recovered.save()
            self.assertEqual(MediaLibrary(library.root).state['volume'], 7)
            self.assertTrue(list(library.root.glob('library.corrupt-*.json')))

    def test_failed_atomic_save_keeps_the_previous_catalog(self):
        with tempfile.TemporaryDirectory() as folder:
            library = MediaLibrary(Path(folder) / 'library')
            library.save()
            before = library.file.read_bytes()
            library.state['volume'] = 5
            with patch('media.os.replace', side_effect=PermissionError('fixture')):
                with self.assertRaises(OSError):
                    library.save()
            self.assertEqual(library.file.read_bytes(), before)

    def test_import_survives_source_removal_and_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'sample.ogg'
            source.write_bytes(b'local music fixture')
            library = MediaLibrary(Path(folder) / 'library')
            key = library.import_file(source, 'music')
            library.import_file(source, 'music')
            library.state['track'] = key
            library.save()
            source.unlink()
            reopened = MediaLibrary(library.root)
            self.assertEqual(len(reopened.state['music']), 1)
            self.assertEqual(reopened.path(key).read_bytes(), b'local music fixture')
            self.assertIsNone(reopened.path('../sample.ogg'))
            self.assertEqual(reopened.state['background'], '')

    def test_music_stays_quiet_and_ducks_for_speech_and_calls(self):
        volumes = []
        controller = SimpleNamespace(library=SimpleNamespace(state={'volume': 12}),
                                     speaking=False, calling=False,
                                     output=SimpleNamespace(setVolume=volumes.append))
        BackgroundMusic.update_volume(controller)
        controller.speaking = True
        BackgroundMusic.update_volume(controller)
        controller.calling = True
        BackgroundMusic.update_volume(controller)
        self.assertEqual(volumes, [.12, .03, 0])
        controller.calling = controller.speaking = False
        controller.library.state['volume'] = 200
        BackgroundMusic.update_volume(controller)
        self.assertEqual(volumes[-1], .3)

    @unittest.skipUnless(os.name == 'nt', 'Windows packaged-process file redirection')
    def test_redirected_windows_library_keeps_its_models_accessible(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            library = MediaLibrary(base / 'logical')
            library.save()
            storage = base / 'redirected'
            target = storage / 'models' / 'character' / 'model.model3.json'
            target.parent.mkdir(parents=True)
            target.write_text('{}', encoding='utf-8')
            original = Path.resolve
            def resolve(path, *args, **kwargs):
                if path == library.file:
                    return storage / 'library.json'
                if path == library.root / 'models/character/model.model3.json':
                    return target
                return original(path, *args, **kwargs)
            with patch.object(Path, 'resolve', resolve):
                self.assertEqual(library.path('models/character/model.model3.json'), target)
                self.assertIsNone(library.path('../redirected/models/character/model.model3.json'))
                self.assertIsNone(library.path(str(target)))

    def test_redirected_member_cannot_escape_either_storage_root(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            library = MediaLibrary(base / 'logical')
            library.save()
            outside = base / 'outside.model3.json'
            outside.write_text('{}', encoding='utf-8')
            original = Path.resolve
            def resolve(path, *args, **kwargs):
                if path == library.file:
                    return base / 'redirected/library.json'
                if path == library.root / 'models/escape.model3.json':
                    return outside
                return original(path, *args, **kwargs)
            with patch.object(Path, 'resolve', resolve):
                self.assertIsNone(library.path('models/escape.model3.json'))

    def test_symlinked_library_file_does_not_authorize_an_external_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            library = MediaLibrary(base / 'logical')
            library.save()
            original = Path.resolve
            def resolve(path, *args, **kwargs):
                return base / 'outside/library.json' if path == library.file else original(path, *args, **kwargs)
            with patch.object(Path, 'resolve', resolve), patch.object(Path, 'is_symlink', return_value=True):
                self.assertEqual(library._storage_roots(), [library.root.resolve()])
